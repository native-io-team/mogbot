//! The microphone on Windows and Linux (cpal: WASAPI, ALSA/PulseAudio).
//!
//! The stream lives on a thread of its own (cpal's streams aren't `Send` on
//! every platform) and fills one buffer; stopping hands that buffer back as
//! 16 kHz mono.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

pub struct Recording {
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Recording {
    /// Stop the microphone and take what was heard, as 16 kHz mono.
    pub fn finish(mut self) -> Vec<f32> {
        self.halt();
        let samples = std::mem::take(&mut *self.samples.lock().unwrap_or_else(|e| e.into_inner()));
        super::pcm::capped(super::pcm::to_16k(&samples, self.rate))
    }

    fn halt(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        self.halt();
    }
}

/// Start the default input. `on_level` gets 0..1 about fifteen times a second.
pub fn start(on_level: impl Fn(f32) + Send + 'static) -> Result<Recording, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    let (t_stop, t_samples) = (Arc::clone(&stop), Arc::clone(&samples));
    let thread = std::thread::Builder::new()
        .name("dictation-mic".into())
        .spawn(move || {
            let stream = match open(t_samples, on_level) {
                Ok((stream, rate)) => {
                    let _ = ready_tx.send(Ok(rate));
                    stream
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            while !t_stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(30));
            }
            drop(stream);
        })
        .map_err(|e| e.to_string())?;
    let rate = ready_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "The microphone didn't start.".to_string())??;
    Ok(Recording {
        stop,
        samples,
        rate,
        thread: Some(thread),
    })
}

fn open(
    samples: Arc<Mutex<Vec<f32>>>,
    on_level: impl Fn(f32) + Send + 'static,
) -> Result<(cpal::Stream, u32), String> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or_else(|| "No microphone found.".to_string())?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("The microphone can't be used: {e}"))?;
    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    let stream = match format {
        cpal::SampleFormat::F32 => {
            build::<f32>(&device, &config, channels, rate, samples, on_level)
        }
        cpal::SampleFormat::I16 => {
            build::<i16>(&device, &config, channels, rate, samples, on_level)
        }
        cpal::SampleFormat::U16 => {
            build::<u16>(&device, &config, channels, rate, samples, on_level)
        }
        cpal::SampleFormat::I32 => {
            build::<i32>(&device, &config, channels, rate, samples, on_level)
        }
        other => {
            return Err(format!(
                "The microphone's format ({other:?}) isn't supported."
            ))
        }
    }?;
    stream
        .play()
        .map_err(|e| format!("The microphone didn't start: {e}"))?;
    Ok((stream, rate))
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    rate: u32,
    samples: Arc<Mutex<Vec<f32>>>,
    on_level: impl Fn(f32) + Send + 'static,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let per_level = (rate as usize / 15).max(1);
    let mut since = 0usize;
    let mut peak = 0f32;
    let max = (super::MAX_SECONDS * rate as f32) as usize;
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mono: Vec<f32> = data
                    .chunks(channels.max(1))
                    .map(|f| f.iter().map(|s| f32::from_sample(*s)).sum::<f32>() / f.len() as f32)
                    .collect();
                if mono.is_empty() {
                    return;
                }
                let rms = (mono.iter().map(|s| s * s).sum::<f32>() / mono.len() as f32).sqrt();
                peak = peak.max(crate::commands::dictation::level_from_rms(rms));
                since += mono.len();
                if since >= per_level {
                    on_level(peak);
                    since = 0;
                    peak = 0.0;
                }
                if let Ok(mut buf) = samples.lock() {
                    if buf.len() < max {
                        buf.extend_from_slice(&mono);
                    }
                }
            },
            |error| tracing::warn!(%error, "[Dictation] microphone stream error"),
            None,
        )
        .map_err(|e| format!("The microphone can't be used: {e}"))
}
