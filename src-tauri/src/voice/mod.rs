//! Dictation that gets the words right, on every computer.
//!
//! What was heard is written out again when the person stops talking, by
//! Whisper (large-v3-turbo, through whisper.cpp) on this computer, with the
//! team's names as its hint, then given one short pass by a small model that
//! knows those names and the conversation, to fix only what was misheard.
//! Same on macOS, Windows and Linux; the phone sends its recording here.
//!
//! - [`model`]: the one-time download of the Whisper model (574 MB), checked
//!   against its SHA-256 before it is used.
//! - [`pcm`]: audio in: resampling to 16 kHz, and the phone's WAV.
//! - [`transcribe`]: Whisper itself.
//! - [`tidy`]: the names pass (Claude Code's Haiku, no tools, nothing of the
//!   user's setup); skipped, never guessed, when it can't run.
//! - `capture` (Windows and Linux): the microphone. macOS records from the
//!   same AVAudioEngine tap that feeds Apple's live words (commands/dictation.rs).
//!
//! Nothing here leaves the computer except the names pass, which goes to the
//! engine the user already runs their agents on.

pub mod model;
pub mod pcm;
pub mod tidy;
pub mod transcribe;
pub mod words;

#[cfg(not(target_os = "macos"))]
pub mod capture;

/// Below this much speech there is nothing worth writing out again (and
/// Whisper invents words in near silence).
pub const MIN_SECONDS: f32 = 0.4;
/// Whisper's own limit per call is 30 s windows; it walks longer audio
/// itself. Past this a dictation is cut, so one can't hold the computer.
pub const MAX_SECONDS: f32 = 10.0 * 60.0;

/// What a finished dictation became.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Improved {
    /// The words to put in the message box.
    pub text: String,
    /// Whisper's words before the names pass (what Undo puts back when there
    /// was no live transcript to go back to).
    pub raw: String,
    /// The names pass ran and changed something.
    pub tidied: bool,
}

/// Write out 16 kHz mono audio again and tidy it. `None` when the model isn't
/// here yet, there was too little sound, or Whisper failed: the caller keeps
/// what it had.
/// Load Whisper now, in the background, when the model is on this computer:
/// someone has started talking, or opened a chat on the phone.
pub fn warm_up() {
    if let Some(path) = model::ready_path() {
        transcribe::warm(path);
    }
}

pub async fn improve(
    samples_16k: Vec<f32>,
    vocabulary: Vec<String>,
    context: Option<String>,
) -> Option<Improved> {
    if !pcm::worth_transcribing(&samples_16k) {
        return None;
    }
    let path = model::ready_path()?;
    // Your own words first (typed in, or learned from your fixes), then the
    // app's name, then the team's.
    let yours = tokio::task::spawn_blocking(words::load)
        .await
        .unwrap_or_default();
    let vocabulary = words::with_yours(&yours, vocabulary);
    let fixes = yours.fix_lines();
    let names = vocabulary.clone();
    let started = std::time::Instant::now();
    let raw =
        tokio::task::spawn_blocking(move || transcribe::transcribe(&path, &samples_16k, &names))
            .await
            .ok()?
            .map_err(|error| tracing::warn!(%error, "[Dictation] Whisper failed"))
            .ok()?;
    let heard_ms = started.elapsed().as_millis();
    if raw.trim().is_empty() {
        return None;
    }
    let tidied = tidy::tidy(&raw, &vocabulary, &fixes, context.as_deref()).await;
    tracing::info!(
        heard_ms,
        total_ms = started.elapsed().as_millis() as u64,
        tidied = tidied.is_some(),
        "[Dictation] written out again"
    );
    Some(match tidied {
        Some(text) if text != raw => Improved {
            text,
            raw,
            tidied: true,
        },
        _ => Improved {
            text: raw.clone(),
            raw,
            tidied: false,
        },
    })
}

#[cfg(test)]
mod tests {
    /// The real thing, on this computer's model: `MOGBOT_DICTATION_WAV=<file>
    /// cargo test voice::tests::writes_out_a_recording -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "needs the downloaded model and a recording"]
    async fn writes_out_a_recording() {
        let path = std::env::var("MOGBOT_DICTATION_WAV").expect("MOGBOT_DICTATION_WAV");
        let samples = super::pcm::parse_wav(&std::fs::read(path).unwrap()).unwrap();
        let names: Vec<String> = [
            "Lobeva Site",
            "Mogbot Builder",
            "Maverick Rock",
            "Tailscale",
            "Mogbot",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let started = std::time::Instant::now();
        let out = super::improve(samples, names, None).await.expect("words");
        println!("{:?} in {:?}", out, started.elapsed());
        assert!(!out.text.is_empty());
    }
}
