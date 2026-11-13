//! Audio in: what Whisper takes is 16 kHz mono f32 in -1..1.

/// Whisper's sample rate.
pub const RATE: u32 = 16_000;

/// Mono audio at `rate` → 16 kHz, by linear interpolation. Speech sits well
/// under 8 kHz, so this loses nothing Whisper listens to.
pub fn to_16k(samples: &[f32], rate: u32) -> Vec<f32> {
    if rate == RATE || samples.is_empty() || rate == 0 {
        return samples.to_vec();
    }
    let step = rate as f64 / RATE as f64;
    let out_len = ((samples.len() as f64) / step).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let at = i as f64 * step;
        let j = at.floor() as usize;
        let frac = (at - j as f64) as f32;
        let a = samples[j];
        let b = *samples.get(j + 1).unwrap_or(&a);
        out.push(a + (b - a) * frac);
    }
    out
}

/// Interleaved frames → mono, by averaging the channels.
pub fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

/// Enough sound to be worth writing out: at least [`super::MIN_SECONDS`]
/// and some of it above room tone.
pub fn worth_transcribing(samples_16k: &[f32]) -> bool {
    if (samples_16k.len() as f32) < super::MIN_SECONDS * RATE as f32 {
        return false;
    }
    // Loudest 50 ms window, in RMS: speech close to a mic is well above 0.01.
    let window = (RATE / 20) as usize;
    samples_16k
        .chunks(window)
        .map(|w| (w.iter().map(|s| s * s).sum::<f32>() / w.len() as f32).sqrt())
        .fold(0.0f32, f32::max)
        > 0.01
}

/// Cut to the longest dictation taken.
pub fn capped(mut samples_16k: Vec<f32>) -> Vec<f32> {
    let max = (super::MAX_SECONDS * RATE as f32) as usize;
    samples_16k.truncate(max);
    samples_16k
}

/// The phone's recording: a RIFF/WAVE file of 16-bit PCM or 32-bit float,
/// any rate, mono or stereo. Returns 16 kHz mono.
pub fn parse_wav(bytes: &[u8]) -> Result<Vec<f32>, String> {
    let bad = || "That recording isn't a WAV file this computer reads.".to_string();
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad());
    }
    let mut at = 12;
    let mut format: Option<(u16, u16, u32, u16)> = None; // (tag, channels, rate, bits)
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size =
            u32::from_le_bytes(bytes[at + 4..at + 8].try_into().map_err(|_| bad())?) as usize;
        let body = at + 8;
        let end = body.saturating_add(size).min(bytes.len());
        match id {
            b"fmt " if end - body >= 16 => {
                let b = &bytes[body..end];
                let mut tag = u16::from_le_bytes([b[0], b[1]]);
                let channels = u16::from_le_bytes([b[2], b[3]]);
                let rate = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
                let bits = u16::from_le_bytes([b[14], b[15]]);
                // WAVE_FORMAT_EXTENSIBLE: the real tag is the sub-format's first two bytes.
                if tag == 0xFFFE && b.len() >= 26 {
                    tag = u16::from_le_bytes([b[24], b[25]]);
                }
                format = Some((tag, channels, rate, bits));
            }
            b"data" => {
                let (tag, channels, rate, bits) = format.ok_or_else(bad)?;
                if channels == 0 || rate == 0 {
                    return Err(bad());
                }
                let data = &bytes[body..end];
                let samples: Vec<f32> = match (tag, bits) {
                    (1, 16) => data
                        .chunks_exact(2)
                        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                        .collect(),
                    (3, 32) => data
                        .chunks_exact(4)
                        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                        .collect(),
                    _ => return Err(bad()),
                };
                return Ok(to_16k(&to_mono(&samples, channels as usize), rate));
            }
            _ => {}
        }
        // Chunks are padded to an even length.
        at = body.saturating_add(size + (size & 1));
    }
    Err(bad())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav16(rate: u32, channels: u16, samples: &[i16]) -> Vec<u8> {
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
        out.extend_from_slice(&(channels * 2).to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&data);
        out
    }

    #[test]
    fn a_phone_wav_becomes_16k_mono() {
        let stereo: Vec<i16> = (0..48_000 * 2)
            .map(|i| if i % 2 == 0 { 16384 } else { 0 })
            .collect();
        let out = parse_wav(&wav16(48_000, 2, &stereo)).unwrap();
        assert_eq!(out.len(), 16_000);
        assert!((out[100] - 0.25).abs() < 1e-3);
    }

    #[test]
    fn anything_else_is_refused_plainly() {
        assert!(parse_wav(b"not a wav at all").is_err());
        let mut odd = wav16(16_000, 1, &[0; 10]);
        odd[20] = 2; // ADPCM
        assert!(parse_wav(&odd).is_err());
    }

    #[test]
    fn silence_and_a_blip_are_not_worth_writing_out() {
        assert!(!worth_transcribing(&vec![0.0; 16_000 * 3]));
        assert!(!worth_transcribing(&vec![0.3; 1_000]));
        let speech: Vec<f32> = (0..16_000)
            .map(|i| ((i as f32) / 8.0).sin() * 0.2)
            .collect();
        assert!(worth_transcribing(&speech));
    }

    #[test]
    fn resampling_keeps_the_length_in_time() {
        assert_eq!(to_16k(&vec![0.0; 44_100], 44_100).len(), 16_000);
        assert_eq!(to_16k(&vec![0.0; 8_000], 8_000).len(), 16_000);
    }
}
