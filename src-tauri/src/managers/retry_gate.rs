//! The recording kept in history is everything the microphone heard; the model
//! only ever heard what the VAD let through. A kept recording that goes back to
//! the model (retry from history) runs through the same gate first, so the retry
//! hears what the live transcription heard rather than the pauses and room tone
//! between phrases, which the model will happily write sentences over.

use crate::audio_toolkit::vad::{VadFrame, VoiceActivityDetector, VAD_STREAMING_HANGOVER_FRAMES};
use crate::managers::audio::pad_short_model_input;
use crate::managers::model::ModelManager;
use crate::settings::get_settings;
use log::warn;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// Silero's frame: 30 ms at 16 kHz, the size the live path feeds it.
const FRAME: usize = 480;

/// The audio of a kept recording, gated and padded the way a live recording
/// is for the model currently selected. Blocking: builds a Silero session and
/// runs it over the whole recording, so call it off the async runtime.
pub fn gate_for_transcription(app: &AppHandle, samples: Vec<f32>) -> Vec<f32> {
    let settings = get_settings(app);
    if !settings.vad_enabled {
        return samples;
    }
    // Same choice the live start makes: a streaming-capable model records with
    // the longer post-speech tail.
    let streaming = app
        .try_state::<Arc<ModelManager>>()
        .and_then(|models| models.get_model_info(&settings.selected_model))
        .is_some_and(|model| model.supports_streaming);
    let vad = app
        .path()
        .resolve(
            "resources/models/silero_vad_v4.onnx",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(anyhow::Error::from)
        .and_then(|path| crate::managers::audio::recording_vad(&path));
    match vad {
        Ok(mut vad) => {
            if streaming {
                vad.set_hangover_frames(VAD_STREAMING_HANGOVER_FRAMES);
            }
            let mut gated = gate(&mut vad, &samples);
            pad_short_model_input(&mut gated);
            gated
        }
        Err(e) => {
            // Better an ungated retry than none.
            warn!("Could not build the VAD for a retry, sending the whole recording: {e}");
            samples
        }
    }
}

/// Feed `samples` through `vad` in 30 ms frames and keep what it passes, the
/// way the recorder does: the last partial frame is zero-padded, and a
/// detector error keeps the frame rather than dropping speech.
fn gate(vad: &mut dyn VoiceActivityDetector, samples: &[f32]) -> Vec<f32> {
    vad.reset();
    let mut out = Vec::with_capacity(samples.len());
    let mut padded = [0.0f32; FRAME];
    for chunk in samples.chunks(FRAME) {
        let frame: &[f32] = if chunk.len() == FRAME {
            chunk
        } else {
            padded[..chunk.len()].copy_from_slice(chunk);
            &padded
        };
        match vad.push_frame(frame) {
            Ok(VadFrame::Speech(kept)) => out.extend_from_slice(kept),
            Ok(VadFrame::Noise) => {}
            Err(_) => out.extend_from_slice(frame),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Speech exactly when a frame's first sample is positive.
    struct PositiveIsSpeech;

    impl VoiceActivityDetector for PositiveIsSpeech {
        fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> anyhow::Result<VadFrame<'a>> {
            if frame[0] > 0.0 {
                Ok(VadFrame::Speech(frame))
            } else {
                Ok(VadFrame::Noise)
            }
        }
    }

    struct Broken;

    impl VoiceActivityDetector for Broken {
        fn push_frame<'a>(&'a mut self, _frame: &'a [f32]) -> anyhow::Result<VadFrame<'a>> {
            anyhow::bail!("inference failed")
        }
    }

    #[test]
    fn keeps_speech_frames_and_drops_the_pause() {
        let mut samples = vec![0.5; 2 * FRAME];
        samples.extend(vec![-0.1; 3 * FRAME]);
        samples.extend(vec![0.25; FRAME]);
        let out = gate(&mut PositiveIsSpeech, &samples);
        let mut expected = vec![0.5; 2 * FRAME];
        expected.extend(vec![0.25; FRAME]);
        assert_eq!(out, expected);
    }

    #[test]
    fn a_short_last_frame_is_padded_like_the_recorder_pads_it() {
        let samples = vec![0.5; FRAME + 100];
        let out = gate(&mut PositiveIsSpeech, &samples);
        let mut expected = vec![0.5; FRAME + 100];
        expected.resize(2 * FRAME, 0.0);
        assert_eq!(out, expected);
    }

    #[test]
    fn a_short_retry_is_padded_like_a_short_live_take() {
        // Half a second of speech reaches the model as 1.25 s, as it does live.
        let mut out = gate(&mut PositiveIsSpeech, &vec![0.5; 16 * FRAME]);
        pad_short_model_input(&mut out);
        assert_eq!(out.len(), 20_000);
        assert!(out[..16 * FRAME].iter().all(|&s| s == 0.5));
        assert!(out[16 * FRAME..].iter().all(|&s| s == 0.0));

        // Nothing kept stays nothing: no speech is not padded into silence.
        let mut none = gate(&mut PositiveIsSpeech, &vec![-0.5; 4 * FRAME]);
        pad_short_model_input(&mut none);
        assert!(none.is_empty());
    }

    #[test]
    fn a_detector_error_keeps_the_audio() {
        let samples = vec![-0.5; 2 * FRAME];
        assert_eq!(gate(&mut Broken, &samples), samples);
    }
}
