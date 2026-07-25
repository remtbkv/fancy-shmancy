use crate::actions::ACTION_MAP;
use crate::managers::audio::AudioRecordingManager;
use log::{debug, error, warn};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const DEBOUNCE: Duration = Duration::from_millis(30);
const RELEASE_GRACE: Duration = Duration::from_millis(50);

/// Double-tap lock (push-to-talk only): a release is treated as a possible first
/// tap when the key was held for less than this.
const TAP_MAX_HOLD: Duration = Duration::from_millis(350);
/// How long after a tap-length release a second press still counts as a double tap.
const DOUBLE_TAP_WINDOW: Duration = Duration::from_millis(400);
/// Presses arriving sooner than this after a release are key auto-repeat
/// (X11 synthesises release/press pairs a few ms apart), not a human double tap.
const MIN_TAP_GAP: Duration = Duration::from_millis(40);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PttAction {
    Passthrough,
    DeferRelease,
    CancelRelease,
}

/// Double-tap-lock handling, evaluated before the normal push-to-talk path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LockAction {
    /// Second tap arrived in time: latch recording on and keep it running.
    Engage,
    /// Press while latched: stop recording.
    Stop,
    /// Release while latched: recording stays on.
    IgnoreRelease,
    /// Nothing lock-specific about this event.
    None,
}

struct PendingRelease {
    binding_id: String,
    hotkey_string: String,
    deadline: Instant,
    /// The key was held only briefly, so this release may be the first half of a
    /// double tap. Set only when double-tap lock is enabled.
    tap_candidate: bool,
    released_at: Instant,
}

/// Commands processed sequentially by the coordinator thread.
enum Command {
    Input {
        binding_id: String,
        hotkey_string: String,
        is_pressed: bool,
        push_to_talk: bool,
        double_tap_lock: bool,
    },
    Cancel {
        recording_was_active: bool,
    },
    ProcessingFinished,
}

/// Pipeline lifecycle, owned exclusively by the coordinator thread.
enum Stage {
    Idle,
    Recording(String), // binding_id
    Processing,
}

fn classify_ptt_event(
    pending_release_binding: Option<&str>,
    is_pressed: bool,
    push_to_talk: bool,
    binding_id: &str,
    recording_binding: Option<&str>,
) -> PttAction {
    if !push_to_talk {
        return PttAction::Passthrough;
    }

    if is_pressed {
        if pending_release_binding == Some(binding_id) {
            PttAction::CancelRelease
        } else {
            PttAction::Passthrough
        }
    } else if recording_binding == Some(binding_id) && pending_release_binding.is_none() {
        PttAction::DeferRelease
    } else {
        PttAction::Passthrough
    }
}

/// Decide whether an event belongs to the double-tap lock, which layers a latch
/// on top of push-to-talk: tap twice to keep recording without holding the key,
/// press once more to stop.
///
/// `pending_tap` is the pending deferred release when it was short enough to be
/// a first tap, along with how long ago it happened.
fn classify_lock_event(
    lock_enabled: bool,
    locked: bool,
    is_pressed: bool,
    binding_id: &str,
    recording_binding: Option<&str>,
    pending_tap: Option<(&str, Duration)>,
) -> LockAction {
    if !lock_enabled {
        return LockAction::None;
    }

    if is_pressed {
        if locked && recording_binding == Some(binding_id) {
            return LockAction::Stop;
        }
        match pending_tap {
            Some((pending_binding, gap))
                if pending_binding == binding_id && gap >= MIN_TAP_GAP =>
            {
                LockAction::Engage
            }
            _ => LockAction::None,
        }
    } else if locked && recording_binding == Some(binding_id) {
        LockAction::IgnoreRelease
    } else {
        LockAction::None
    }
}

/// Serialises all transcription lifecycle events through a single thread
/// to eliminate race conditions between keyboard shortcuts, signals, and
/// the async transcribe-paste pipeline.
pub struct TranscriptionCoordinator {
    tx: Sender<Command>,
}

pub fn is_transcribe_binding(id: &str) -> bool {
    id == "transcribe" || id == "transcribe_with_post_process"
}

impl TranscriptionCoordinator {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel();

        thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut stage = Stage::Idle;
                let mut last_press: Option<Instant> = None;
                let mut pending_release: Option<PendingRelease> = None;
                // Double-tap lock state: when the current press started (to
                // measure hold length) and whether recording is latched on.
                let mut press_started: Option<(String, Instant)> = None;
                let mut locked = false;

                loop {
                    let cmd = if let Some(pending) = &pending_release {
                        match rx.recv_timeout(
                            pending.deadline.saturating_duration_since(Instant::now()),
                        ) {
                            Ok(cmd) => cmd,
                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                if let Some(pending) = pending_release.take() {
                                    if matches!(&stage, Stage::Recording(id) if id == &pending.binding_id)
                                    {
                                        stop(
                                            &app,
                                            &mut stage,
                                            &pending.binding_id,
                                            &pending.hotkey_string,
                                        );
                                    }
                                }
                                continue;
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    } else {
                        match rx.recv() {
                            Ok(cmd) => cmd,
                            Err(_) => break,
                        }
                    };

                    match cmd {
                        Command::Input {
                            binding_id,
                            hotkey_string,
                            is_pressed,
                            push_to_talk,
                            double_tap_lock,
                        } => {
                            let lock_enabled = push_to_talk && double_tap_lock;
                            let recording_binding = match &stage {
                                Stage::Recording(id) => Some(id.clone()),
                                _ => None,
                            };

                            // Remember when this key went down so a release can
                            // tell a tap from a hold. Auto-repeat re-presses
                            // arrive while a release is deferred; they must not
                            // reset the original press time.
                            if is_pressed
                                && pending_release
                                    .as_ref()
                                    .is_none_or(|pending| pending.binding_id != binding_id)
                            {
                                press_started = Some((binding_id.clone(), Instant::now()));
                            }

                            let pending_tap = pending_release.as_ref().and_then(|pending| {
                                pending
                                    .tap_candidate
                                    .then(|| (pending.binding_id.as_str(), pending.released_at.elapsed()))
                            });

                            match classify_lock_event(
                                lock_enabled,
                                locked,
                                is_pressed,
                                &binding_id,
                                recording_binding.as_deref(),
                                pending_tap,
                            ) {
                                LockAction::Engage => {
                                    pending_release = None;
                                    locked = true;
                                    debug!("Double tap latched recording for '{binding_id}'");
                                    continue;
                                }
                                LockAction::Stop => {
                                    locked = false;
                                    pending_release = None;
                                    stop(&app, &mut stage, &binding_id, &hotkey_string);
                                    continue;
                                }
                                LockAction::IgnoreRelease => continue,
                                LockAction::None => {}
                            }

                            let pending_release_binding = pending_release
                                .as_ref()
                                .map(|pending| pending.binding_id.as_str());

                            match classify_ptt_event(
                                pending_release_binding,
                                is_pressed,
                                push_to_talk,
                                &binding_id,
                                recording_binding.as_deref(),
                            ) {
                                PttAction::CancelRelease => {
                                    pending_release = None;
                                    continue;
                                }
                                PttAction::DeferRelease => {
                                    // A short hold may be the first tap of a
                                    // double tap, so hold the release open for
                                    // the whole double-tap window instead of the
                                    // usual auto-repeat grace.
                                    let tap_candidate = lock_enabled
                                        && press_started
                                            .as_ref()
                                            .filter(|(id, _)| id == &binding_id)
                                            .is_some_and(|(_, at)| at.elapsed() < TAP_MAX_HOLD);
                                    let released_at = Instant::now();
                                    let grace = if tap_candidate {
                                        DOUBLE_TAP_WINDOW
                                    } else {
                                        RELEASE_GRACE
                                    };
                                    pending_release = Some(PendingRelease {
                                        binding_id,
                                        hotkey_string,
                                        deadline: released_at + grace,
                                        tap_candidate,
                                        released_at,
                                    });
                                    continue;
                                }
                                PttAction::Passthrough => {}
                            }

                            // Debounce rapid-fire press events (key repeat / double-tap).
                            // Push-to-talk releases may be deferred above to absorb X11 auto-repeat.
                            if is_pressed {
                                let now = Instant::now();
                                if last_press.is_some_and(|t| now.duration_since(t) < DEBOUNCE) {
                                    debug!("Debounced press for '{binding_id}'");
                                    continue;
                                }
                                last_press = Some(now);
                            }

                            if push_to_talk {
                                if is_pressed && matches!(stage, Stage::Idle) {
                                    start(&app, &mut stage, &binding_id, &hotkey_string);
                                } else if !is_pressed
                                    && matches!(&stage, Stage::Recording(id) if id == &binding_id)
                                {
                                    stop(&app, &mut stage, &binding_id, &hotkey_string);
                                }
                            } else if is_pressed {
                                match &stage {
                                    Stage::Idle => {
                                        start(&app, &mut stage, &binding_id, &hotkey_string);
                                    }
                                    Stage::Recording(id) if id == &binding_id => {
                                        stop(&app, &mut stage, &binding_id, &hotkey_string);
                                    }
                                    _ => {
                                        debug!("Ignoring press for '{binding_id}': pipeline busy")
                                    }
                                }
                            }
                        }
                        Command::Cancel {
                            recording_was_active,
                        } => {
                            pending_release = None;
                            locked = false;
                            // Don't reset during processing — wait for the pipeline to finish.
                            if !matches!(stage, Stage::Processing)
                                && (recording_was_active || matches!(stage, Stage::Recording(_)))
                            {
                                stage = Stage::Idle;
                            }
                        }
                        Command::ProcessingFinished => {
                            stage = Stage::Idle;
                            locked = false;
                        }
                    }
                }
                debug!("Transcription coordinator exited");
            }));
            if let Err(e) = result {
                error!("Transcription coordinator panicked: {e:?}");
            }
        });

        Self { tx }
    }

    /// Send a keyboard/signal input event for a transcribe binding.
    /// For signal-based toggles, use `is_pressed: true` and `push_to_talk: false`.
    pub fn send_input(
        &self,
        binding_id: &str,
        hotkey_string: &str,
        is_pressed: bool,
        push_to_talk: bool,
        double_tap_lock: bool,
    ) {
        if self
            .tx
            .send(Command::Input {
                binding_id: binding_id.to_string(),
                hotkey_string: hotkey_string.to_string(),
                is_pressed,
                push_to_talk,
                double_tap_lock,
            })
            .is_err()
        {
            warn!("Transcription coordinator channel closed");
        }
    }

    pub fn notify_cancel(&self, recording_was_active: bool) {
        if self
            .tx
            .send(Command::Cancel {
                recording_was_active,
            })
            .is_err()
        {
            warn!("Transcription coordinator channel closed");
        }
    }

    pub fn notify_processing_finished(&self) {
        if self.tx.send(Command::ProcessingFinished).is_err() {
            warn!("Transcription coordinator channel closed");
        }
    }
}

fn start(app: &AppHandle, stage: &mut Stage, binding_id: &str, hotkey_string: &str) {
    let Some(action) = ACTION_MAP.get(binding_id) else {
        warn!("No action in ACTION_MAP for '{binding_id}'");
        return;
    };
    action.start(app, binding_id, hotkey_string);
    if app
        .try_state::<Arc<AudioRecordingManager>>()
        .is_some_and(|a| a.is_recording())
    {
        *stage = Stage::Recording(binding_id.to_string());
    } else {
        debug!("Start for '{binding_id}' did not begin recording; staying idle");
    }
}

fn stop(app: &AppHandle, stage: &mut Stage, binding_id: &str, hotkey_string: &str) {
    let Some(action) = ACTION_MAP.get(binding_id) else {
        warn!("No action in ACTION_MAP for '{binding_id}'");
        return;
    };
    action.stop(app, binding_id, hotkey_string);
    *stage = Stage::Processing;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_to_talk_release_while_recording_defers_release() {
        assert_eq!(
            classify_ptt_event(None, false, true, "transcribe", Some("transcribe")),
            PttAction::DeferRelease
        );
    }

    #[test]
    fn push_to_talk_press_matching_pending_release_cancels_release() {
        assert_eq!(
            classify_ptt_event(
                Some("transcribe"),
                true,
                true,
                "transcribe",
                Some("transcribe")
            ),
            PttAction::CancelRelease
        );
    }

    #[test]
    fn toggle_mode_press_and_release_pass_through() {
        assert_eq!(
            classify_ptt_event(
                Some("transcribe"),
                true,
                false,
                "transcribe",
                Some("transcribe")
            ),
            PttAction::Passthrough
        );
        assert_eq!(
            classify_ptt_event(None, false, false, "transcribe", Some("transcribe")),
            PttAction::Passthrough
        );
    }

    #[test]
    fn press_for_different_binding_than_pending_release_passes_through() {
        assert_eq!(
            classify_ptt_event(
                Some("transcribe"),
                true,
                true,
                "transcribe_with_post_process",
                Some("transcribe")
            ),
            PttAction::Passthrough
        );
    }

    #[test]
    fn press_matching_pending_release_cancels_without_recording_state() {
        assert_eq!(
            classify_ptt_event(Some("transcribe"), true, true, "transcribe", None),
            PttAction::CancelRelease
        );
    }

    // ---------------------------------------------------------------------
    // Sequence-level regression coverage for issue #1539.
    //
    // Under X11 key auto-repeat, holding a push-to-talk key does not emit one
    // long press. It emits the initial press followed by a stream of
    // synthesized release/press pairs, then a single genuine release on key-up.
    // Before the fix, every synthesized release passed straight through and
    // stopped recording, so holding the key "rapidly toggled" recording on and
    // off. The fix defers each release for a short grace window and cancels it
    // when the matching auto-repeat press arrives.
    //
    // The unit tests above assert `classify_ptt_event` in isolation. The
    // simulator below threads that classifier through the same `pending_release`
    // / `stage` state transitions the coordinator loop performs (lines that
    // handle `Command::Input` and the `recv_timeout` grace expiry), so a whole
    // event burst can be exercised deterministically without a Tauri AppHandle
    // or real timers.
    // ---------------------------------------------------------------------

    const BINDING: &str = "transcribe";

    #[derive(Clone, Copy)]
    enum Ev {
        /// A key-down event (real initial press or a synthesized auto-repeat press).
        Press,
        /// A key-up event (synthesized auto-repeat release or the genuine key-up).
        Release,
        /// The `RELEASE_GRACE` window elapsed with no cancelling press arriving.
        Grace,
    }

    #[derive(Debug, PartialEq, Eq)]
    enum SimStage {
        Idle,
        Recording,
        Processing,
    }

    struct SimResult {
        starts: u32,
        stops: u32,
        stage: SimStage,
    }

    /// Mirror of the coordinator loop's decision logic for a single push-to-talk
    /// binding: it calls the real `classify_ptt_event` and applies the exact same
    /// Defer / Cancel / debounce / start / stop transitions.
    fn simulate(events: &[Ev]) -> SimResult {
        let mut stage = SimStage::Idle;
        let mut pending: Option<String> = None;
        let mut last_press_ms: Option<u64> = None;
        let mut clock_ms: u64 = 0;
        let mut starts = 0u32;
        let mut stops = 0u32;
        let debounce_ms = DEBOUNCE.as_millis() as u64;

        for ev in events {
            // Auto-repeat events arrive a few ms apart, well inside DEBOUNCE.
            clock_ms += 5;

            match ev {
                Ev::Grace => {
                    // Coordinator's `RecvTimeoutError::Timeout` arm: fire the
                    // deferred release iff we are still recording that binding.
                    if let Some(pending_binding) = pending.take() {
                        if stage == SimStage::Recording && pending_binding == BINDING {
                            stage = SimStage::Processing;
                            stops += 1;
                        }
                    }
                }
                Ev::Press | Ev::Release => {
                    let is_pressed = matches!(ev, Ev::Press);
                    let pending_binding = pending.as_deref();
                    let recording_binding = if stage == SimStage::Recording {
                        Some(BINDING)
                    } else {
                        None
                    };

                    match classify_ptt_event(
                        pending_binding,
                        is_pressed,
                        true, // push_to_talk
                        BINDING,
                        recording_binding,
                    ) {
                        PttAction::CancelRelease => {
                            pending = None;
                            continue;
                        }
                        PttAction::DeferRelease => {
                            pending = Some(BINDING.to_string());
                            continue;
                        }
                        PttAction::Passthrough => {}
                    }

                    if is_pressed {
                        if last_press_ms.is_some_and(|t| clock_ms - t < debounce_ms) {
                            continue;
                        }
                        last_press_ms = Some(clock_ms);
                    }

                    if is_pressed && stage == SimStage::Idle {
                        stage = SimStage::Recording;
                        starts += 1;
                    } else if !is_pressed && stage == SimStage::Recording {
                        stage = SimStage::Processing;
                        stops += 1;
                    }
                }
            }
        }

        SimResult {
            starts,
            stops,
            stage,
        }
    }

    /// Initial press plus several synthesized release/press pairs, as X11 emits
    /// while a push-to-talk key is held down.
    fn autorepeat_burst() -> Vec<Ev> {
        let mut events = vec![Ev::Press];
        for _ in 0..6 {
            events.push(Ev::Release);
            events.push(Ev::Press);
        }
        events
    }

    /// Regression for #1539: a burst of X11 auto-repeat release/press pairs must
    /// not stop recording. Before the fix the first synthesized release stopped
    /// recording immediately (stops == 1, stage left Recording), which produced
    /// the rapid on/off toggling. With the fix the releases are coalesced and
    /// recording stays continuously active for the whole burst.
    #[test]
    fn x11_autorepeat_burst_does_not_toggle_recording() {
        let result = simulate(&autorepeat_burst());
        assert_eq!(result.starts, 1, "recording should start exactly once");
        assert_eq!(
            result.stops, 0,
            "synthesized auto-repeat releases must not stop recording mid-burst"
        );
        assert_eq!(
            result.stage,
            SimStage::Recording,
            "recording must remain active across the entire auto-repeat burst"
        );
    }

    /// Complements the burst test: once the key is genuinely released and the
    /// grace window elapses with no re-press, recording stops exactly once. This
    /// proves the debounce only coalesces synthesized releases and does not wedge
    /// the coordinator or swallow the real key-up.
    #[test]
    fn genuine_release_after_grace_stops_recording_once() {
        let mut events = autorepeat_burst();
        events.push(Ev::Release); // genuine key-up
        events.push(Ev::Grace); // grace window elapses, no cancelling press
        let result = simulate(&events);
        assert_eq!(result.starts, 1, "recording should start exactly once");
        assert_eq!(
            result.stops, 1,
            "a genuine release should stop recording exactly once"
        );
        assert_eq!(result.stage, SimStage::Processing);
    }

    // ---------------------------------------------------------------------
    // Double-tap lock: hold the shortcut for push-to-talk as usual, or tap it
    // twice to latch recording on and stop with one more press.
    // ---------------------------------------------------------------------

    #[test]
    fn lock_disabled_never_reports_a_lock_action() {
        assert_eq!(
            classify_lock_event(
                false,
                false,
                true,
                BINDING,
                None,
                Some((BINDING, Duration::from_millis(120)))
            ),
            LockAction::None
        );
        assert_eq!(
            classify_lock_event(false, true, false, BINDING, Some(BINDING), None),
            LockAction::None
        );
    }

    #[test]
    fn second_tap_inside_the_window_engages_the_lock() {
        assert_eq!(
            classify_lock_event(
                true,
                false,
                true,
                BINDING,
                Some(BINDING),
                Some((BINDING, Duration::from_millis(120)))
            ),
            LockAction::Engage
        );
    }

    /// Auto-repeat presses land a few milliseconds after their synthesized
    /// release. They must fall through to the existing CancelRelease path
    /// instead of latching recording on.
    #[test]
    fn press_immediately_after_release_is_autorepeat_not_a_double_tap() {
        assert_eq!(
            classify_lock_event(
                true,
                false,
                true,
                BINDING,
                Some(BINDING),
                Some((BINDING, Duration::from_millis(5)))
            ),
            LockAction::None
        );
    }

    #[test]
    fn second_tap_of_a_different_binding_does_not_engage() {
        assert_eq!(
            classify_lock_event(
                true,
                false,
                true,
                "transcribe_with_post_process",
                Some(BINDING),
                Some((BINDING, Duration::from_millis(120)))
            ),
            LockAction::None
        );
    }

    #[test]
    fn while_latched_press_stops_and_release_is_ignored() {
        assert_eq!(
            classify_lock_event(true, true, true, BINDING, Some(BINDING), None),
            LockAction::Stop
        );
        assert_eq!(
            classify_lock_event(true, true, false, BINDING, Some(BINDING), None),
            LockAction::IgnoreRelease
        );
    }

    /// Sequence-level mirror of the coordinator loop with a millisecond clock,
    /// so tap length and the gap between taps — which decide latching — can be
    /// exercised deterministically.
    #[derive(Clone, Copy)]
    enum LEv {
        Press,
        Release,
        /// Advance the clock, firing a deferred release if its deadline passes.
        Wait(u64),
    }

    struct LockSim {
        lock_enabled: bool,
        clock: u64,
        stage: SimStage,
        locked: bool,
        press_started: Option<u64>,
        /// (tap_candidate, released_at, deadline)
        pending: Option<(bool, u64, u64)>,
        last_press: Option<u64>,
        starts: u32,
        stops: u32,
    }

    fn ms(d: Duration) -> u64 {
        d.as_millis() as u64
    }

    impl LockSim {
        fn new(lock_enabled: bool) -> Self {
            Self {
                lock_enabled,
                clock: 0,
                stage: SimStage::Idle,
                locked: false,
                press_started: None,
                pending: None,
                last_press: None,
                starts: 0,
                stops: 0,
            }
        }

        fn wait(&mut self, duration: u64) {
            let target = self.clock + duration;
            if let Some((_, _, deadline)) = self.pending {
                if deadline <= target {
                    self.clock = deadline;
                    self.pending = None;
                    if self.stage == SimStage::Recording {
                        self.stage = SimStage::Processing;
                        self.stops += 1;
                    }
                }
            }
            self.clock = target;
        }

        fn input(&mut self, is_pressed: bool) {
            let recording = if self.stage == SimStage::Recording {
                Some(BINDING)
            } else {
                None
            };

            if is_pressed && self.pending.is_none() {
                self.press_started = Some(self.clock);
            }

            let pending_tap = self.pending.and_then(|(tap_candidate, released_at, _)| {
                tap_candidate
                    .then(|| (BINDING, Duration::from_millis(self.clock - released_at)))
            });

            match classify_lock_event(
                self.lock_enabled,
                self.locked,
                is_pressed,
                BINDING,
                recording,
                pending_tap,
            ) {
                LockAction::Engage => {
                    self.pending = None;
                    self.locked = true;
                    return;
                }
                LockAction::Stop => {
                    self.locked = false;
                    self.pending = None;
                    self.stage = SimStage::Processing;
                    self.stops += 1;
                    return;
                }
                LockAction::IgnoreRelease => return,
                LockAction::None => {}
            }

            match classify_ptt_event(
                self.pending.map(|_| BINDING),
                is_pressed,
                true,
                BINDING,
                recording,
            ) {
                PttAction::CancelRelease => {
                    self.pending = None;
                    return;
                }
                PttAction::DeferRelease => {
                    let tap_candidate = self.lock_enabled
                        && self
                            .press_started
                            .is_some_and(|at| self.clock - at < ms(TAP_MAX_HOLD));
                    let grace = if tap_candidate {
                        ms(DOUBLE_TAP_WINDOW)
                    } else {
                        ms(RELEASE_GRACE)
                    };
                    self.pending = Some((tap_candidate, self.clock, self.clock + grace));
                    return;
                }
                PttAction::Passthrough => {}
            }

            if is_pressed {
                if self
                    .last_press
                    .is_some_and(|t| self.clock - t < ms(DEBOUNCE))
                {
                    return;
                }
                self.last_press = Some(self.clock);
            }

            if is_pressed && self.stage == SimStage::Idle {
                self.stage = SimStage::Recording;
                self.starts += 1;
            } else if !is_pressed && self.stage == SimStage::Recording {
                self.stage = SimStage::Processing;
                self.stops += 1;
            }
        }

        fn run(&mut self, events: &[LEv]) {
            for ev in events {
                match ev {
                    LEv::Press => self.input(true),
                    LEv::Release => self.input(false),
                    LEv::Wait(duration) => self.wait(*duration),
                }
            }
        }
    }

    /// Tap, tap, let go: recording stays on with no key held and no second
    /// recording started.
    #[test]
    fn double_tap_latches_one_continuous_recording() {
        let mut sim = LockSim::new(true);
        sim.run(&[
            LEv::Press,
            LEv::Wait(90),
            LEv::Release,
            LEv::Wait(120),
            LEv::Press,
            LEv::Wait(80),
            LEv::Release,
            LEv::Wait(3_000),
        ]);
        assert_eq!(sim.starts, 1, "the two taps are one recording");
        assert_eq!(sim.stops, 0, "latched recording must not stop on its own");
        assert!(sim.locked, "recording should be latched");
        assert_eq!(sim.stage, SimStage::Recording);
    }

    #[test]
    fn press_after_latching_stops_recording_once() {
        let mut sim = LockSim::new(true);
        sim.run(&[
            LEv::Press,
            LEv::Wait(90),
            LEv::Release,
            LEv::Wait(120),
            LEv::Press,
            LEv::Wait(80),
            LEv::Release,
            LEv::Wait(5_000),
            LEv::Press, // stop
            LEv::Wait(60),
            LEv::Release,
            LEv::Wait(1_000),
        ]);
        assert_eq!(sim.starts, 1);
        assert_eq!(sim.stops, 1, "one press stops the latched recording");
        assert!(!sim.locked);
        assert_eq!(sim.stage, SimStage::Processing);
    }

    /// A lone tap that never gets a partner still stops, just after the
    /// double-tap window rather than the shorter auto-repeat grace.
    #[test]
    fn single_tap_stops_after_the_double_tap_window() {
        let mut sim = LockSim::new(true);
        sim.run(&[LEv::Press, LEv::Wait(90), LEv::Release, LEv::Wait(100)]);
        assert_eq!(sim.stops, 0, "still waiting for a possible second tap");
        sim.wait(400);
        assert_eq!(sim.stops, 1, "no second tap arrived, so recording stops");
        assert_eq!(sim.stage, SimStage::Processing);
    }

    /// A real push-to-talk hold is not a tap, so its release is not held open
    /// for the double-tap window — it stops on the usual grace.
    #[test]
    fn held_key_release_stops_on_the_normal_grace() {
        let mut sim = LockSim::new(true);
        sim.run(&[LEv::Press, LEv::Wait(1_500), LEv::Release, LEv::Wait(60)]);
        assert_eq!(sim.starts, 1);
        assert_eq!(sim.stops, 1, "a hold should not wait out the double-tap window");
        assert!(!sim.locked);
    }

    /// Regression guard for #1539 with the lock enabled: X11 auto-repeat emits
    /// release/press pairs milliseconds apart, which must neither stop nor latch
    /// recording.
    #[test]
    fn autorepeat_does_not_latch_recording() {
        let mut sim = LockSim::new(true);
        let mut events = vec![LEv::Press, LEv::Wait(20)];
        for _ in 0..6 {
            events.extend([LEv::Release, LEv::Wait(5), LEv::Press, LEv::Wait(25)]);
        }
        sim.run(&events);
        assert_eq!(sim.starts, 1);
        assert_eq!(sim.stops, 0);
        assert!(!sim.locked, "auto-repeat must not latch recording");

        // Genuine key-up: recording ends without the user having to press again.
        sim.run(&[LEv::Release, LEv::Wait(500)]);
        assert_eq!(sim.stops, 1);
        assert!(!sim.locked);
        assert_eq!(sim.stage, SimStage::Processing);
    }

    /// With the setting off, a quick tap behaves exactly as it does upstream:
    /// stopped by the short release grace, never latched.
    #[test]
    fn lock_disabled_keeps_upstream_push_to_talk_timing() {
        let mut sim = LockSim::new(false);
        sim.run(&[LEv::Press, LEv::Wait(90), LEv::Release, LEv::Wait(60)]);
        assert_eq!(sim.starts, 1);
        assert_eq!(sim.stops, 1);
        assert!(!sim.locked);
    }
}
