//! Files between the phone and the Mac, kept off the socket.
//!
//! Two kinds of blob, both staged in one owner-only folder and both gone
//! after an hour:
//!
//! - **Uploads** (`PUT /v1/blobs`): a file the phone is about to attach. An
//!   `agents.send` naming it hands the staged copy to the desktop's own
//!   `attachments::save`, so the limits, name cleaning and prompt block are
//!   the desk's; the blob is consumed once the send succeeds.
//! - **Produced** (`agents.fetchPath`): a file on the Mac an agent's reply
//!   pointed at, copied here so the phone downloads a snapshot of it from
//!   `GET /v1/blobs/:id`.
//!
//! A blob belongs to the device that made it; no other device can read,
//! send or even learn of it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::agents::attachments::{self, MAX_FILE_BYTES};
use crate::errors::CommandError;

/// How long a staged blob lives.
pub const BLOB_TTL_MS: u64 = 60 * 60 * 1000;
/// Staged at once per device: a full message (10 files) twice over, plus a
/// few fetched files.
pub const MAX_BLOBS_PER_DEVICE: usize = 30;
/// Bytes staged at once per device.
pub const MAX_BYTES_PER_DEVICE: u64 = 300 * 1024 * 1024;

/// `BlobRef` in methods.ts.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlobRef {
    pub blob_id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct Blob {
    pub id: String,
    pub device_id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub path: PathBuf,
    pub created: u64,
}

impl Blob {
    pub fn as_ref(&self) -> BlobRef {
        BlobRef {
            blob_id: self.id.clone(),
            name: self.name.clone(),
            mime: self.mime.clone(),
            size: self.size,
        }
    }
}

pub struct Blobs {
    dir: PathBuf,
    /// Removed with the store (tests); the desktop's folder is kept.
    temporary: bool,
    map: Mutex<HashMap<String, Blob>>,
    /// Room held for uploads still arriving, by reservation id: counted in
    /// the budget from before the first byte is read, so many at once can't
    /// each see room that only one of them has.
    reserved: Arc<Mutex<HashMap<String, Held>>>,
    /// Devices revoked while this ran: nothing more is staged for them, even
    /// by an upload that was already on its way.
    gone: Mutex<HashSet<String>>,
}

#[derive(Debug, Clone)]
pub struct Held {
    device_id: String,
    bytes: u64,
}

/// Room for one incoming file, held in the budget until it is committed or
/// dropped. Dropping it (the upload failed, the phone went away, the request
/// was cancelled) gives the room back and removes the partial file.
pub struct Reservation {
    id: String,
    device_id: String,
    /// Where the bytes go while they arrive.
    pub path: PathBuf,
    /// The most this upload may write.
    pub max: u64,
    reserved: Arc<Mutex<HashMap<String, Held>>>,
    committed: bool,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.reserved
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// A user-facing refusal: too big, too many, not found.
fn expected(message: impl Into<String>) -> CommandError {
    CommandError::expected(message)
}

pub fn too_big_message(name: &str) -> String {
    format!(
        "{name} is over {} MB, the most a file can be.",
        MAX_FILE_BYTES / (1024 * 1024)
    )
}

const FULL: &str =
    "Too many files are waiting to be sent from this phone. Send or wait an hour, then try again.";

impl Blobs {
    pub fn new(dir: PathBuf) -> Self {
        // Whatever an earlier run staged has expired with it.
        let _ = std::fs::remove_dir_all(&dir);
        Self::at(dir, false)
    }

    /// A store in its own temporary folder, removed on drop (tests).
    pub fn temporary() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "ss-companion-blobs-{}",
            uuid::Uuid::new_v4().simple()
        ));
        Self::at(dir, true)
    }

    fn at(dir: PathBuf, temporary: bool) -> Self {
        Blobs {
            dir,
            temporary,
            map: Mutex::new(HashMap::new()),
            reserved: Arc::new(Mutex::new(HashMap::new())),
            gone: Mutex::new(HashSet::new()),
        }
    }

    /// The staging folder (tests check nothing is left in it).
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Blob>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_reserved(&self) -> std::sync::MutexGuard<'_, HashMap<String, Held>> {
        self.reserved.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn is_gone(&self, device_id: &str) -> bool {
        self.gone
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(device_id)
    }

    fn ensure_dir(&self) -> Result<(), CommandError> {
        std::fs::create_dir_all(&self.dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    /// Drop everything older than the TTL, files and all.
    pub fn sweep(&self, now: u64) {
        let expired: Vec<Blob> = {
            let mut map = self.lock();
            let ids: Vec<String> = map
                .values()
                .filter(|b| now.saturating_sub(b.created) >= BLOB_TTL_MS)
                .map(|b| b.id.clone())
                .collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        for b in expired {
            let _ = std::fs::remove_file(&b.path);
        }
    }

    /// Hold room for up to `max` bytes for this device, or say why not.
    /// The check and the hold happen under one lock (the staged map's, then
    /// the held map's, always in that order), so concurrent uploads can't
    /// all squeeze through on the same free space.
    pub fn reserve(
        &self,
        device_id: &str,
        max: u64,
        now: u64,
    ) -> Result<Reservation, CommandError> {
        self.sweep(now);
        if self.is_gone(device_id) {
            return Err(expected("This phone isn't paired any more."));
        }
        self.ensure_dir()?;
        let map = self.lock();
        let mut reserved = self.lock_reserved();
        let (count, bytes) = map
            .values()
            .filter(|b| b.device_id == device_id)
            .map(|b| b.size)
            .chain(
                reserved
                    .values()
                    .filter(|h| h.device_id == device_id)
                    .map(|h| h.bytes),
            )
            .fold((0usize, 0u64), |(n, t), size| (n + 1, t + size));
        if count >= MAX_BLOBS_PER_DEVICE || bytes + max > MAX_BYTES_PER_DEVICE {
            return Err(expected(FULL));
        }
        let id = format!("blob_{}", uuid::Uuid::new_v4().simple());
        reserved.insert(
            id.clone(),
            Held {
                device_id: device_id.to_string(),
                bytes: max,
            },
        );
        Ok(Reservation {
            path: self.dir.join(&id),
            id,
            device_id: device_id.to_string(),
            max,
            reserved: self.reserved.clone(),
            committed: false,
        })
    }

    /// The bytes are all in `reservation.path` (at most `max` of them):
    /// make it a blob. Refused, and the file removed, if the device was
    /// revoked while it arrived.
    pub fn commit(
        &self,
        mut reservation: Reservation,
        name: &str,
        mime: String,
        size: u64,
        now: u64,
    ) -> Result<Blob, CommandError> {
        if size > reservation.max {
            return Err(expected(too_big_message(&attachments::sanitize_name(name))));
        }
        restrict(&reservation.path)?;
        let blob = Blob {
            id: reservation.id.clone(),
            device_id: reservation.device_id.clone(),
            name: attachments::sanitize_name(name),
            mime,
            size,
            path: reservation.path.clone(),
            created: now,
        };
        {
            let mut map = self.lock();
            // Checked under the staged map's lock, which `forget_device`
            // also takes: a revoke either sees this blob and removes it, or
            // happened first and this one never lands.
            if self.is_gone(&blob.device_id) {
                return Err(expected("This phone isn't paired any more."));
            }
            map.insert(blob.id.clone(), blob.clone());
            reservation.committed = true;
        }
        Ok(blob)
    }

    /// Stage bytes already in memory (`agents.send` tests, small writes).
    /// `mime` is trusted only when it's a plain `type/subtype`.
    pub fn put(
        &self,
        device_id: &str,
        name: &str,
        mime: Option<&str>,
        bytes: &[u8],
        now: u64,
    ) -> Result<Blob, CommandError> {
        let clean = attachments::sanitize_name(name);
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(expected(too_big_message(&clean)));
        }
        let reservation = self.reserve(device_id, bytes.len() as u64, now)?;
        write_private(&reservation.path, bytes)?;
        let mime = upload_mime(mime, &clean);
        self.commit(reservation, name, mime, bytes.len() as u64, now)
    }

    /// Copy a file on the Mac in for this device to download. The copy stops
    /// at the size limit even if the file grows while it's read.
    pub fn produce(&self, device_id: &str, source: &Path, now: u64) -> Result<Blob, CommandError> {
        let name = source
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into());
        let size = std::fs::metadata(source)?.len();
        if size > MAX_FILE_BYTES {
            return Err(expected(too_big_message(&name)));
        }
        // Held at the most a file can be while it copies, so a file that
        // grows meanwhile still fits what was held.
        let reservation = self.reserve(device_id, MAX_FILE_BYTES, now)?;
        let Some(copied) = copy_bounded(source, &reservation.path, MAX_FILE_BYTES)? else {
            return Err(expected(too_big_message(&name)));
        };
        let mime = attachments::mime_for(&name).to_string();
        self.commit(reservation, &name, mime, copied, now)
    }

    /// This device's blob, if it has one by that id and it hasn't expired.
    pub fn get(&self, device_id: &str, id: &str, now: u64) -> Option<Blob> {
        self.sweep(now);
        self.lock()
            .get(id)
            .filter(|b| b.device_id == device_id)
            .cloned()
    }

    /// Forget blobs whose job is done (an upload after it was sent).
    pub fn consume(&self, ids: &[String]) {
        let gone: Vec<Blob> = {
            let mut map = self.lock();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        for b in gone {
            let _ = std::fs::remove_file(&b.path);
        }
    }

    /// A device was revoked: every blob it left behind goes now, and nothing
    /// more is staged for it (an upload still arriving is refused when it
    /// finishes, and its partial file removed).
    pub fn forget_device(&self, device_id: &str) {
        let gone: Vec<Blob> = {
            let mut map = self.lock();
            self.gone
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(device_id.to_string());
            let ids: Vec<String> = map
                .values()
                .filter(|b| b.device_id == device_id)
                .map(|b| b.id.clone())
                .collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        for b in gone {
            let _ = std::fs::remove_file(&b.path);
        }
    }
}

/// An upload's Content-Type, trusted only when it's a plain `type/subtype`;
/// otherwise what the name says.
pub fn upload_mime(mime: Option<&str>, name: &str) -> String {
    mime.map(|m| {
        m.split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
    })
    .filter(|m| is_plain_mime(m) && m != "application/octet-stream")
    .unwrap_or_else(|| attachments::mime_for(name).to_string())
}

/// Copy at most `limit` bytes; `None` if there was more than that.
fn copy_bounded(source: &Path, dest: &Path, limit: u64) -> std::io::Result<Option<u64>> {
    use std::io::Read;
    let from = std::fs::File::open(source)?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut to = opts.open(dest)?;
    let n = std::io::copy(&mut from.take(limit + 1), &mut to)?;
    if n > limit {
        drop(to);
        let _ = std::fs::remove_file(dest);
        return Ok(None);
    }
    Ok(Some(n))
}

impl Drop for Blobs {
    fn drop(&mut self) {
        if self.temporary {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

fn is_plain_mime(m: &str) -> bool {
    let mut parts = m.split('/');
    let ok = |p: Option<&str>| {
        p.is_some_and(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
        })
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)?;
    restrict(path)
}

fn restrict(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blob_belongs_to_its_device_and_expires() {
        let b = Blobs::temporary();
        let blob = b
            .put("dev_a", "../photo.PNG", Some("image/png"), b"png", 0)
            .unwrap();
        assert_eq!(blob.name, "photo.PNG");
        assert_eq!(blob.mime, "image/png");
        assert!(b.get("dev_a", &blob.id, 1).is_some());
        assert!(
            b.get("dev_b", &blob.id, 1).is_none(),
            "another device's blob"
        );
        assert!(b.get("dev_a", &blob.id, BLOB_TTL_MS).is_none(), "expired");
        assert!(!blob.path.exists(), "its file goes with it");
    }

    #[test]
    fn mime_falls_back_to_the_name_and_ignores_junk() {
        let b = Blobs::temporary();
        let t = |mime: Option<&str>| b.put("d", "notes.md", mime, b"x", 0).unwrap().mime;
        assert_eq!(t(None), "text/markdown");
        assert_eq!(t(Some("application/octet-stream")), "text/markdown");
        assert_eq!(t(Some("text/plain; charset=utf-8")), "text/plain");
        assert_eq!(t(Some("text/html\r\nX: y")), "text/markdown");
    }

    #[test]
    fn a_device_has_a_staging_budget() {
        let b = Blobs::temporary();
        for _ in 0..MAX_BLOBS_PER_DEVICE {
            b.put("d", "a.txt", None, b"x", 0).unwrap();
        }
        assert!(b.put("d", "a.txt", None, b"x", 0).is_err());
        assert!(b.put("other", "a.txt", None, b"x", 0).is_ok());
        let staged: Vec<String> = b
            .lock()
            .values()
            .filter(|x| x.device_id == "d")
            .map(|x| x.id.clone())
            .collect();
        b.consume(&staged);
        assert!(
            b.put("d", "a.txt", None, b"x", 0).is_ok(),
            "room again once sent"
        );
    }

    #[test]
    fn concurrent_reservations_cant_overrun_the_budget() {
        let b = std::sync::Arc::new(Blobs::temporary());
        let handles: Vec<_> = (0..80)
            .map(|_| {
                let b = b.clone();
                std::thread::spawn(move || b.reserve("d", 4 * 1024 * 1024, 0).ok())
            })
            .collect();
        let held: Vec<Reservation> = handles
            .into_iter()
            .filter_map(|h| h.join().unwrap())
            .collect();
        assert_eq!(held.len(), MAX_BLOBS_PER_DEVICE, "never more than the cap");
        // Room comes back when they're dropped (a failed or cancelled upload).
        drop(held);
        assert!(b.reserve("d", 1, 0).is_ok());
    }

    #[test]
    fn a_reservation_counts_its_size_before_any_byte_arrives() {
        let b = Blobs::temporary();
        let _big = b.reserve("d", MAX_BYTES_PER_DEVICE - 10, 0).unwrap();
        assert!(b.reserve("d", 11, 0).is_err());
        assert!(b.reserve("d", 10, 0).is_ok());
    }

    #[test]
    fn an_upload_that_finishes_after_revoke_is_thrown_away() {
        let b = Blobs::temporary();
        let r = b.reserve("d", 10, 0).unwrap();
        write_private(&r.path, b"half").unwrap();
        let path = r.path.clone();
        let staged = b.put("d", "x.txt", None, b"x", 0).unwrap();
        b.forget_device("d");
        assert!(
            !staged.path.exists(),
            "what it had staged is deleted at once"
        );
        assert!(b.commit(r, "a.txt", "text/plain".into(), 4, 0).is_err());
        assert!(!path.exists(), "its partial file is gone");
        assert!(b.reserve("d", 1, 0).is_err(), "nothing more for it");
    }

    #[test]
    fn a_dropped_reservation_removes_its_partial_file() {
        let b = Blobs::temporary();
        let r = b.reserve("d", 10, 0).unwrap();
        write_private(&r.path, b"partial").unwrap();
        let path = r.path.clone();
        drop(r);
        assert!(!path.exists());
    }

    #[test]
    fn a_fetched_copy_stops_at_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("big.bin");
        std::fs::write(&src, vec![0u8; 100]).unwrap();
        let dest = dir.path().join("copy");
        assert_eq!(copy_bounded(&src, &dest, 100).unwrap(), Some(100));
        assert_eq!(copy_bounded(&src, &dest, 99).unwrap(), None);
        assert!(!dest.exists(), "an over-long copy leaves nothing");
    }

    #[cfg(unix)]
    #[test]
    fn staged_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let b = Blobs::temporary();
        let blob = b.put("d", "a.txt", None, b"x", 0).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&blob.path), 0o600);
        assert_eq!(mode(blob.path.parent().unwrap()), 0o700);
    }
}
