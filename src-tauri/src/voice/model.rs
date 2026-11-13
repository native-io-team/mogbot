//! The Whisper model: downloaded once into the app's folder, checked against
//! its published SHA-256 before it is ever loaded, and reported as it comes.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

/// large-v3-turbo, 5-bit: near large-v3's accuracy at a fraction of the time.
pub const FILE: &str = "ggml-large-v3-turbo-q5_0.bin";
const URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";
pub const BYTES: u64 = 574_041_195;
const SHA256: &str = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";

/// Progress, for the composer's line. Payload: [`ModelStatus`].
pub const MODEL_EVENT: &str = "dictation://model";

static DOWNLOADING: AtomicBool = AtomicBool::new(false);
static RECEIVED: AtomicU64 = AtomicU64::new(0);
static FAILED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub ready: bool,
    pub downloading: bool,
    pub received: u64,
    pub total: u64,
    /// The last download stopped short (no connection, a wrong file).
    pub failed: bool,
}

fn dir() -> PathBuf {
    crate::brand::app_support_dir().join("models")
}

pub fn path() -> PathBuf {
    dir().join(FILE)
}

/// The model's path once it is here and whole (checked when it arrived;
/// its size is checked again on every use).
pub fn ready_path() -> Option<PathBuf> {
    let p = path();
    let len = std::fs::metadata(&p).ok()?.len();
    (len == BYTES).then_some(p)
}

pub fn status() -> ModelStatus {
    ModelStatus {
        ready: ready_path().is_some(),
        downloading: DOWNLOADING.load(Ordering::SeqCst),
        received: RECEIVED.load(Ordering::SeqCst),
        total: BYTES,
        failed: FAILED.load(Ordering::SeqCst),
    }
}

fn announce(app: &AppHandle) {
    let _ = app.emit(MODEL_EVENT, status());
}

/// Fetch the model unless it's here or coming. Returns at once; progress
/// and the end arrive as [`MODEL_EVENT`].
pub fn ensure(app: &AppHandle) {
    if ready_path().is_some() || DOWNLOADING.swap(true, Ordering::SeqCst) {
        return;
    }
    FAILED.store(false, Ordering::SeqCst);
    RECEIVED.store(0, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = download(&app).await;
        if let Err(error) = &result {
            tracing::warn!(%error, "[Dictation] model download failed");
            FAILED.store(true, Ordering::SeqCst);
        } else {
            tracing::info!("[Dictation] model ready");
        }
        DOWNLOADING.store(false, Ordering::SeqCst);
        announce(&app);
    });
}

async fn download(app: &AppHandle) -> Result<(), String> {
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    let part = dir().join(format!("{FILE}.part"));
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(URL)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut received = 0u64;
    let mut last_told = 0u64;
    loop {
        let chunk = tokio::time::timeout(std::time::Duration::from_secs(60), response.chunk())
            .await
            .map_err(|_| "The download stalled.".to_string())?
            .map_err(|e| e.to_string())?;
        let Some(chunk) = chunk else { break };
        received += chunk.len() as u64;
        if received > BYTES {
            break;
        }
        hash.update(&chunk);
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        RECEIVED.store(received, Ordering::SeqCst);
        // About every 1%.
        if received - last_told >= BYTES / 100 {
            last_told = received;
            announce(app);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    let sum = hex::encode(hash.finalize());
    if received != BYTES || sum != SHA256 {
        let _ = std::fs::remove_file(&part);
        return Err(format!("wrong file ({received} bytes, sha256 {sum})"));
    }
    std::fs::rename(&part, path()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_model_lives_in_the_apps_own_folder() {
        let p = super::path();
        assert!(p.starts_with(crate::brand::app_support_dir()));
        assert!(p.ends_with(super::FILE));
    }
}
