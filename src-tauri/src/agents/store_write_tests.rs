//! `write_atomic` under the faults it exists for (child of store.rs).
use super::*;

/// Two writers saving the same file at once (a settings change from the
/// desk while a loop records its state, say) each land whole: the file is
/// always exactly one of the versions written, and neither write fails.
/// With one shared `<name>.tmp` they truncated and renamed each other's
/// copy: a half-written file was renamed into place, and the other write
/// failed with "No such file or directory".
#[test]
fn writers_racing_on_one_file_never_tear_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.json");
    write_atomic(&path, b"[]").unwrap();
    let versions: Vec<Vec<u8>> = (0..6u8)
        .map(|i| {
            let body = vec![b'a' + i; 256 * 1024];
            serde_json::to_vec(&String::from_utf8(body).unwrap()).unwrap()
        })
        .collect();
    let failures = std::sync::atomic::AtomicUsize::new(0);
    let torn = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        for version in &versions {
            let (path, failures) = (&path, &failures);
            s.spawn(move || {
                for _ in 0..25 {
                    if write_atomic(path, version).is_err() {
                        failures.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                }
            });
        }
        let (path, torn, versions) = (&path, &torn, &versions);
        s.spawn(move || {
            for _ in 0..400 {
                // Windows refuses a read for the instant a file is being
                // replaced (a sharing violation): that is no torn file.
                let Ok(now) = std::fs::read(path) else {
                    continue;
                };
                if now != b"[]" && !versions.contains(&now) {
                    torn.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }
        });
    });
    assert_eq!(failures.into_inner(), 0, "a write failed");
    assert_eq!(torn.into_inner(), 0, "a torn file was in place");
    assert!(versions.contains(&std::fs::read(&path).unwrap()));
    let left: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != "state.json")
        .collect();
    assert!(left.is_empty(), "left behind: {left:?}");
}

/// A write that can't finish (a full disk; here, a folder where the file
/// goes) leaves the old file as it was and no copy beside it: a stray
/// temp file only fills the disk further.
#[test]
fn a_failed_write_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("inbox.json");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("keep"), b"x").unwrap();
    assert!(write_atomic(&path, b"[1]").is_err());
    let names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["inbox.json".to_string()]);
}
