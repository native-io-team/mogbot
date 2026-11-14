//! Settings → Agents → Dictation → Your words, and learning from the fixes
//! you make to dictated words before sending (`crate::voice::words`).

use crate::errors::CommandError;
use crate::voice::words::{self, Store};

fn failed(error: String) -> CommandError {
    CommandError::Other {
        message: format!("Couldn't save your words: {error}"),
    }
}

/// Your words and the fixes behind the learned ones.
#[tauri::command]
#[tracing::instrument]
pub async fn dictation_words() -> Result<Store, CommandError> {
    tokio::task::spawn_blocking(words::load)
        .await
        .map_err(|e| CommandError::Other {
            message: e.to_string(),
        })
}

#[tauri::command]
#[tracing::instrument]
pub async fn dictation_word_add(word: String) -> Result<Store, CommandError> {
    tokio::task::spawn_blocking(move || words::add(&word))
        .await
        .map_err(|e| CommandError::Other {
            message: e.to_string(),
        })?
        .map_err(failed)
}

#[tauri::command]
#[tracing::instrument]
pub async fn dictation_word_remove(word: String) -> Result<Store, CommandError> {
    tokio::task::spawn_blocking(move || words::remove(&word))
        .await
        .map_err(|e| CommandError::Other {
            message: e.to_string(),
        })?
        .map_err(failed)
}

/// A dictated message as it was sent: the words it taught (usually none).
#[tauri::command]
#[tracing::instrument(skip(dictated, sent))]
pub async fn dictation_learn(dictated: String, sent: String) -> Result<Vec<String>, CommandError> {
    tokio::task::spawn_blocking(move || words::learn(&dictated, &sent))
        .await
        .map_err(|e| CommandError::Other {
            message: e.to_string(),
        })
}
