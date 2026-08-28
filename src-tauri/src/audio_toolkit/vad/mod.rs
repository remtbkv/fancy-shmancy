use anyhow::Result;

pub const VAD_PREFILL_FRAMES: usize = 15;
pub const VAD_OFFLINE_HANGOVER_FRAMES: usize = 15;
pub const VAD_STREAMING_HANGOVER_FRAMES: usize = 55;
pub const VAD_ONSET_FRAMES: usize = 2;

/// How far above the room floor a frame has to sit to be admitted as speech
/// even when Silero says otherwise, and how much history the floor is measured
/// over. Silero reports an absolute probability, so as the room gets louder its
/// confidence in a fixed voice falls and the gate starts deleting words. Level
/// relative to the current floor keeps working when the floor moves.
pub const VAD_RESCUE_MARGIN_DB: f32 = 5.0;
pub const VAD_FLOOR_WINDOW_FRAMES: usize = 100; // ~3 s at 30 ms/frame
pub const VAD_FLOOR_MIN_FRAMES: usize = 20;

pub enum VadFrame<'a> {
    /// Speech – may aggregate several frames (prefill + current + hangover)
    Speech(&'a [f32]),
    /// Non-speech (silence, noise). Down-stream code can ignore it.
    Noise,
}

impl<'a> VadFrame<'a> {
    #[inline]
    pub fn is_speech(&self) -> bool {
        matches!(self, VadFrame::Speech(_))
    }
}

pub trait VoiceActivityDetector: Send + Sync {
    /// The last frame's verdict straight from the detector, before any onset or
    /// hangover smoothing. The overlay's bar reads this: the tail that keeps a
    /// word from being clipped is right for a transcript and far too slow for a
    /// waveform, which has to settle when the speaking does.
    fn last_raw_voice(&self) -> bool {
        true
    }

    /// Primary streaming API: feed one 30-ms frame, get keep/drop decision.
    fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>>;

    fn is_voice(&mut self, frame: &[f32]) -> Result<bool> {
        Ok(self.push_frame(frame)?.is_speech())
    }

    /// Set the post-speech hangover tail (in 30 ms frames) applied to
    /// subsequent frames. Detectors without a smoothing tail can ignore this.
    fn set_hangover_frames(&mut self, _frames: usize) {}

    fn reset(&mut self) {}
}

mod silero;
mod smoothed;

pub use silero::SileroVad;
pub use smoothed::SmoothedVad;
