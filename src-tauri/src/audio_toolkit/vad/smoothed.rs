use super::{
    VadFrame, VoiceActivityDetector, VAD_FLOOR_MIN_FRAMES, VAD_FLOOR_WINDOW_FRAMES,
    VAD_RESCUE_MARGIN_DB, VAD_RESCUE_MIN_PROB,
};
use anyhow::Result;
use std::collections::VecDeque;

pub struct SmoothedVad {
    inner_vad: Box<dyn VoiceActivityDetector>,
    prefill_frames: usize,
    hangover_frames: usize,
    onset_frames: usize,

    frame_buffer: VecDeque<Vec<f32>>,
    floor_history: VecDeque<f32>,
    hangover_counter: usize,
    onset_counter: usize,
    in_speech: bool,
    last_raw_voice: bool,

    temp_out: Vec<f32>,
}

fn frame_dbfs(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return -120.0;
    }
    let mean_sq = frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32;
    20.0 * mean_sq.sqrt().max(1e-7).log10()
}

/// 20th percentile of the trailing window: low enough to sit in the room tone
/// rather than the speech, high enough that one dead frame can't define it.
fn floor_estimate(history: &VecDeque<f32>) -> f32 {
    let mut sorted: Vec<f32> = history.iter().copied().collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    sorted[(sorted.len() as f32 * 0.2) as usize]
}

impl SmoothedVad {
    pub fn new(
        inner_vad: Box<dyn VoiceActivityDetector>,
        prefill_frames: usize,
        hangover_frames: usize,
        onset_frames: usize,
    ) -> Self {
        Self {
            inner_vad,
            prefill_frames,
            hangover_frames,
            onset_frames,
            frame_buffer: VecDeque::new(),
            floor_history: VecDeque::new(),
            hangover_counter: 0,
            onset_counter: 0,
            in_speech: false,
            last_raw_voice: false,
            temp_out: Vec::new(),
        }
    }
}

impl VoiceActivityDetector for SmoothedVad {
    fn last_raw_voice(&self) -> bool {
        self.last_raw_voice
    }

    fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>> {
        // 1. Buffer every incoming frame for possible pre-roll
        self.frame_buffer.push_back(frame.to_vec());
        while self.frame_buffer.len() > self.prefill_frames + 1 {
            self.frame_buffer.pop_front();
        }

        // 2. Delegate to the wrapped boolean VAD, then give a frame that clearly
        //    stands above the room a second chance. Silero's probability is
        //    absolute, so a noisier room drags it under the threshold on speech
        //    it would pass in a quiet one and the gate deletes words outright.
        self.floor_history.push_back(frame_dbfs(frame));
        while self.floor_history.len() > VAD_FLOOR_WINDOW_FRAMES {
            self.floor_history.pop_front();
        }

        let mut is_voice = self.inner_vad.is_voice(frame)?;
        if !is_voice
            && self.floor_history.len() >= VAD_FLOOR_MIN_FRAMES
            && self.inner_vad.last_prob() > VAD_RESCUE_MIN_PROB
        {
            let level = *self.floor_history.back().unwrap();
            is_voice = level > floor_estimate(&self.floor_history) + VAD_RESCUE_MARGIN_DB;
        }
        self.last_raw_voice = is_voice;

        match (self.in_speech, is_voice) {
            // Potential start of speech - need to accumulate onset frames
            (false, true) => {
                self.onset_counter += 1;
                if self.onset_counter >= self.onset_frames {
                    // We have enough consecutive voice frames to trigger speech
                    self.in_speech = true;
                    self.hangover_counter = self.hangover_frames;
                    self.onset_counter = 0; // Reset for next time

                    // Collect prefill + current frame
                    self.temp_out.clear();
                    for buf in &self.frame_buffer {
                        self.temp_out.extend(buf);
                    }
                    Ok(VadFrame::Speech(&self.temp_out))
                } else {
                    // Not enough frames yet, still silence
                    Ok(VadFrame::Noise)
                }
            }

            // Ongoing Speech
            (true, true) => {
                self.hangover_counter = self.hangover_frames;
                Ok(VadFrame::Speech(frame))
            }

            // End of Speech or interruption during onset phase
            (true, false) => {
                if self.hangover_counter > 0 {
                    self.hangover_counter -= 1;
                    Ok(VadFrame::Speech(frame))
                } else {
                    self.in_speech = false;
                    Ok(VadFrame::Noise)
                }
            }

            // Silence or broken onset sequence
            (false, false) => {
                self.onset_counter = 0; // Reset onset counter on silence
                Ok(VadFrame::Noise)
            }
        }
    }

    fn set_hangover_frames(&mut self, frames: usize) {
        self.hangover_frames = frames;
    }

    fn reset(&mut self) {
        self.inner_vad.reset();
        self.frame_buffer.clear();
        self.floor_history.clear();
        self.hangover_counter = 0;
        self.onset_counter = 0;
        self.in_speech = false;
        self.temp_out.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stands in for Silero having lost confidence in a noisy room: it never
    /// reports voice, so anything that gets through came from the level rescue.
    /// Its score stays in the band the rescue is meant to serve.
    struct NeverVoice;

    impl VoiceActivityDetector for NeverVoice {
        fn last_prob(&self) -> f32 {
            0.15
        }

        fn push_frame<'a>(&'a mut self, _frame: &'a [f32]) -> Result<VadFrame<'a>> {
            Ok(VadFrame::Noise)
        }
    }

    /// A frame the detector is certain holds no voice at all — a keypress, a
    /// chair creak. Loud relative to the room, and still not speech.
    struct CertainlyNotVoice;

    impl VoiceActivityDetector for CertainlyNotVoice {
        fn last_prob(&self) -> f32 {
            0.001
        }

        fn push_frame<'a>(&'a mut self, _frame: &'a [f32]) -> Result<VadFrame<'a>> {
            Ok(VadFrame::Noise)
        }
    }

    fn tone(amplitude: f32) -> Vec<f32> {
        (0..480)
            .map(|i| amplitude * (i as f32 * 0.3).sin())
            .collect()
    }

    fn feed(vad: &mut SmoothedVad, frame: &[f32], count: usize) -> usize {
        (0..count)
            .filter(|_| vad.push_frame(frame).unwrap().is_speech())
            .count()
    }

    #[test]
    fn steady_room_tone_never_opens_the_gate() {
        let mut vad = SmoothedVad::new(Box::new(NeverVoice), 15, 15, 2);
        assert_eq!(feed(&mut vad, &tone(0.01), 200), 0);
    }

    #[test]
    fn a_level_well_above_the_floor_is_rescued() {
        let mut vad = SmoothedVad::new(Box::new(NeverVoice), 15, 15, 2);
        // Establish a floor first; the rescue is inert until it has history.
        assert_eq!(feed(&mut vad, &tone(0.01), 60), 0);
        // +20 dB over that floor is not room tone, whatever Silero thinks.
        assert!(feed(&mut vad, &tone(0.1), 10) > 0);
    }

    #[test]
    fn a_loud_transient_the_detector_rejects_outright_is_not_rescued() {
        let mut vad = SmoothedVad::new(Box::new(CertainlyNotVoice), 15, 15, 2);
        assert_eq!(feed(&mut vad, &tone(0.01), 60), 0);
        // Same +20 dB burst the marginal detector gets rescued on. Level alone
        // must not open the gate, or a minute of typing becomes a paragraph of
        // invented text.
        assert_eq!(feed(&mut vad, &tone(0.1), 10), 0);
    }

    #[test]
    fn a_level_inside_the_margin_is_not_rescued() {
        let mut vad = SmoothedVad::new(Box::new(NeverVoice), 15, 15, 2);
        assert_eq!(feed(&mut vad, &tone(0.01), 60), 0);
        // +3 dB sits under VAD_RESCUE_MARGIN_DB, so the gate stays shut.
        assert_eq!(feed(&mut vad, &tone(0.0141), 10), 0);
    }
}
