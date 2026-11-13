//! Whisper (whisper.cpp through whisper-rs). The model is loaded for each
//! dictation and let go after: kept in a static, ggml's Metal backend aborts
//! the process as it exits (its device is torn down under a live context), so
//! quitting the app would crash. One at a time.

use std::path::Path;
use std::sync::Mutex;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// The names Whisper is primed with, as one short sentence (its prompt holds
/// about 220 tokens; past that it's ignored).
pub fn hint(names: &[String]) -> String {
    let mut out = String::new();
    for name in names {
        let name = name.trim();
        if name.is_empty() || out.len() + name.len() > 600 {
            continue;
        }
        if !out.is_empty() {
            out.push_str(", ");
        }
        out.push_str(name);
    }
    if out.is_empty() {
        out
    } else {
        format!("{out}.")
    }
}

pub fn transcribe(model: &Path, samples_16k: &[f32], names: &[String]) -> Result<String, String> {
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let started = std::time::Instant::now();
    let ctx = WhisperContext::new_with_params(model, WhisperContextParameters::default())
        .map_err(|e| format!("Whisper couldn't load its model: {e}"))?;
    tracing::info!(
        ms = started.elapsed().as_millis() as u64,
        "[Dictation] Whisper loaded"
    );
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;

    let mut params = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: 5,
        patience: -1.0,
    });
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4) as i32;
    params.set_n_threads(threads);
    params.set_language(Some("auto"));
    params.set_translate(false);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    let prompt = hint(names);
    if !prompt.is_empty() {
        params.set_initial_prompt(&prompt);
    }
    state.full(params, samples_16k).map_err(|e| e.to_string())?;

    let mut text = String::new();
    for segment in state.as_iter() {
        let piece = segment.to_str_lossy().map_err(|e| e.to_string())?;
        text.push_str(&piece);
    }
    Ok(clean(&text))
}

/// Whisper's spacing, and what it writes for no speech at all.
pub fn clean(text: &str) -> String {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let silent = ["[BLANK_AUDIO]", "[ Silence ]", "(silence)", "[Music]"];
    if silent.iter().any(|s| t.eq_ignore_ascii_case(s)) {
        return String::new();
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hint_lists_names_and_stays_short() {
        assert_eq!(
            hint(&["Mogbot".into(), " ".into(), "Lobeva".into()]),
            "Mogbot, Lobeva."
        );
        let many: Vec<String> = (0..200).map(|i| format!("Agent number {i}")).collect();
        assert!(hint(&many).len() <= 603);
        assert_eq!(hint(&[]), "");
    }

    #[test]
    fn no_speech_is_nothing() {
        assert_eq!(clean("  [BLANK_AUDIO] "), "");
        assert_eq!(clean(" Ship   it\n now. "), "Ship it now.");
    }
}
