use super::{
    VadFrame, VadTailReport, VoiceActivityDetector, VAD_FLOOR_MIN_FRAMES, VAD_FLOOR_WINDOW_FRAMES,
    VAD_RESCUE_MARGIN_DB, VAD_RESCUE_MIN_PROB,
};
use anyhow::Result;
use std::collections::VecDeque;

/// One pre-roll buffer slot. `emitted` keeps a speech onset from handing the
/// recording a frame it already has; `voiced` feeds the end-of-recording
/// `tail_report()` diagnostic.
struct BufferedFrame {
    samples: Vec<f32>,
    emitted: bool,
    voiced: bool,
}

pub struct SmoothedVad {
    inner_vad: Box<dyn VoiceActivityDetector>,
    prefill_frames: usize,
    hangover_frames: usize,
    onset_frames: usize,

    frame_buffer: VecDeque<BufferedFrame>,
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

    fn mark_last_emitted(&mut self) {
        if let Some(frame) = self.frame_buffer.back_mut() {
            frame.emitted = true;
        }
    }
}

impl VoiceActivityDetector for SmoothedVad {
    fn last_raw_voice(&self) -> bool {
        self.last_raw_voice
    }

    fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>> {
        // 1. Buffer every incoming frame for possible pre-roll
        self.frame_buffer.push_back(BufferedFrame {
            samples: frame.to_vec(),
            emitted: false,
            voiced: false,
        });
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
        if let Some(last) = self.frame_buffer.back_mut() {
            last.voiced = is_voice;
        }

        match (self.in_speech, is_voice) {
            // Potential start of speech - need to accumulate onset frames
            (false, true) => {
                self.onset_counter += 1;
                if self.onset_counter >= self.onset_frames {
                    // We have enough consecutive voice frames to trigger speech
                    self.in_speech = true;
                    self.hangover_counter = self.hangover_frames;
                    self.onset_counter = 0; // Reset for next time

                    // Collect prefill + current frame. A pause shorter than the
                    // prefill leaves hangover frames in the buffer that already
                    // went out; handing them over again played the end of the
                    // last phrase twice.
                    self.temp_out.clear();
                    for buffered in self.frame_buffer.iter_mut() {
                        if !buffered.emitted {
                            self.temp_out.extend(buffered.samples.iter());
                            buffered.emitted = true;
                        }
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
                self.mark_last_emitted();
                Ok(VadFrame::Speech(frame))
            }

            // End of Speech or interruption during onset phase
            (true, false) => {
                if self.hangover_counter > 0 {
                    self.hangover_counter -= 1;
                    self.mark_last_emitted();
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

    /// Trailing run of withheld frames plus smoothing state. Interior
    /// withheld frames (before already-emitted speech) are not counted.
    fn tail_report(&self) -> Option<VadTailReport> {
        let mut withheld_frames = 0;
        let mut withheld_voiced_frames = 0;
        for frame in self
            .frame_buffer
            .iter()
            .rev()
            .take_while(|frame| !frame.emitted)
        {
            withheld_frames += 1;
            if frame.voiced {
                withheld_voiced_frames += 1;
            }
        }

        Some(VadTailReport {
            withheld_frames,
            withheld_voiced_frames,
            in_speech: self.in_speech,
            onset_counter: self.onset_counter,
            hangover_counter: self.hangover_counter,
        })
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

    /// Inner VAD that replays a scripted voice/no-voice sequence.
    struct ScriptedVad {
        script: VecDeque<bool>,
    }

    impl ScriptedVad {
        fn new(script: &[bool]) -> Self {
            Self {
                script: script.iter().copied().collect(),
            }
        }
    }

    impl VoiceActivityDetector for ScriptedVad {
        fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>> {
            if self.script.pop_front().unwrap_or(false) {
                Ok(VadFrame::Speech(frame))
            } else {
                Ok(VadFrame::Noise)
            }
        }
    }

    /// Every sample of frame `id` carries `id`, so the output names exactly
    /// which input frames reached the recording, and in what order.
    fn frame_ids(vad: &mut SmoothedVad, count: usize) -> Vec<usize> {
        let mut ids = Vec::new();
        for id in 1..=count {
            let frame = vec![id as f32; 4];
            if let VadFrame::Speech(out) = vad.push_frame(&frame).unwrap() {
                for chunk in out.chunks(4) {
                    ids.push(chunk[0] as usize);
                }
            }
        }
        ids
    }

    #[test]
    fn a_short_pause_does_not_replay_the_frames_before_it() {
        // prefill 3, hangover 2, onset 2. Speech, the two hangover frames, one
        // dropped frame, then speech again: the onset's pre-roll reaches back
        // over frame 4, which the hangover already handed out. Recordings
        // carried that repeat — up to 390 ms of the end of a phrase, twice.
        let script = [true, true, false, false, false, true, true];
        let mut vad = SmoothedVad::new(Box::new(ScriptedVad::new(&script)), 3, 2, 2);
        assert_eq!(frame_ids(&mut vad, script.len()), vec![1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn no_frame_reaches_the_recording_twice_or_out_of_order() {
        // Any voice pattern, any pause length: what comes out is an ordered
        // subset of what went in. Scripts alternate runs of speech and pause
        // so pauses land on both sides of the hangover + prefill span, which
        // is where a repeat used to come from.
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = |bound: u64| {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) % bound
        };
        for _ in 0..500 {
            let mut script = Vec::new();
            let mut voiced = next(2) == 0;
            while script.len() < 200 {
                let run = 1 + next(if voiced { 20 } else { 45 }) as usize;
                script.extend(std::iter::repeat_n(voiced, run));
                voiced = !voiced;
            }
            let mut vad = SmoothedVad::new(Box::new(ScriptedVad::new(&script)), 15, 15, 2);
            let ids = frame_ids(&mut vad, script.len());
            assert!(
                ids.windows(2).all(|w| w[0] < w[1]),
                "script {script:?} produced {ids:?}"
            );
        }
    }

    #[test]
    fn a_pause_longer_than_the_prefill_still_gets_its_full_preroll() {
        // prefill 3, hangover 1, onset 2: silence from frame 4 on, so frame 4
        // falls outside the pre-roll and stays dropped; the onset at 8 hands
        // back 5, 6, 7, 8 — the full prefill plus the onset frame.
        let script = [true, true, false, false, false, false, true, true];
        let mut vad = SmoothedVad::new(Box::new(ScriptedVad::new(&script)), 3, 1, 2);
        assert_eq!(frame_ids(&mut vad, script.len()), vec![1, 2, 3, 5, 6, 7, 8]);
    }

    #[test]
    fn tail_report_counts_withheld_onset_tail() {
        // One voiced frame at the end: onset (2 frames) never confirms, so
        // both trailing frames are withheld and one of them is voiced.
        let mut vad = SmoothedVad::new(Box::new(ScriptedVad::new(&[false, true])), 3, 2, 2);
        assert!(!vad.push_frame(&tone(0.01)).unwrap().is_speech());
        assert!(!vad.push_frame(&tone(0.02)).unwrap().is_speech());

        let report = vad.tail_report().expect("smoothed VAD always reports");
        assert_eq!(report.withheld_frames, 2);
        assert_eq!(report.withheld_voiced_frames, 1);
        assert_eq!(report.onset_counter, 1);
        assert!(!report.in_speech);
    }

    #[test]
    fn tail_report_counts_only_trailing_run() {
        let script = [true, true, false, false, false, false];
        let mut vad = SmoothedVad::new(Box::new(ScriptedVad::new(&script)), 3, 2, 2);
        for _ in 0..4 {
            let _ = vad.push_frame(&tone(0.01)).unwrap();
        }
        assert!(!vad.push_frame(&tone(0.01)).unwrap().is_speech()); // past hangover
        assert!(!vad.push_frame(&tone(0.01)).unwrap().is_speech());

        let report = vad.tail_report().unwrap();
        assert_eq!(report.withheld_frames, 2);
        assert_eq!(report.withheld_voiced_frames, 0);
    }

    #[test]
    fn a_level_inside_the_margin_is_not_rescued() {
        let mut vad = SmoothedVad::new(Box::new(NeverVoice), 15, 15, 2);
        assert_eq!(feed(&mut vad, &tone(0.01), 60), 0);
        // +3 dB sits under VAD_RESCUE_MARGIN_DB, so the gate stays shut.
        assert_eq!(feed(&mut vad, &tone(0.0141), 10), 0);
    }
}
