import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./RecordingOverlay.css";
import { commands, events } from "@/bindings";
import type {
  StreamPhase,
  StreamPhaseEvent,
  StreamTextEvent,
  StreamWorkKind,
} from "@/bindings";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { getLanguageDirection } from "@/lib/utils/rtl";

type OverlayState = "recording" | "streaming" | "transcribing" | "processing";

// ---- Flow bar ---------------------------------------------------------------
// The compact overlay is a copy of Wispr Flow's status bar, down to the numbers:
// ten bars, each with a fixed bulge factor that fattens the middle of the row,
// and a delay ramp that runs 0 → 0.4s outward from the centre and negative on
// the far half, so the bounce sweeps symmetrically. Level is smoothed the same
// way too — an exponential blend per frame with a hard slew limit — which is why
// the bar settles instead of flickering on consonants.
const FLOW_BARS = 10;
const FLOW_BULGE = 1 / 48; // how fast the bulge falls off from the centre bar
const FLOW_GAIN = 5; // level → scale multiplier, and the ceiling on it
const FLOW_FRAME_MS = 1000 / 60;
const FLOW_BLEND = 0.85; // retained fraction of the previous level, per frame
const FLOW_SLEW = 1.6; // max level RISE per second — Wispr's constant
// Falling is allowed to be quicker than Wispr's symmetric rate. Their bar reads
// a raw level, so it drops with the sound; ours is gated on a speech verdict,
// and at 1.6/s the bar would still be coming down half a second after the
// verdict said stop. This is a deliberate divergence, and the reason the bar
// settles when the speaking does.
const FLOW_SLEW_FALL = 6.0;
// Loudness → level. Wispr's scaler keeps a floor that only ever descends to the
// quietest dB it has seen, clamped at -60, and reads the level as how far above
// that floor the current window sits over a 20 dB span.
//
// That assumes a quiet room, and Rem's often are not. Measured off his own
// recordings: ambient sits at -34 to -38 dBFS, so once the floor has descended
// to -60 the ambient alone maps to 1.0 — the top of the range — and the bar is
// pinned full-height by an empty room. It only looked fine on short recordings
// because the floor had not had time to get down there yet, which is exactly
// why the lag grew with duration.
//
// So the floor learns the room instead of hunting the all-time minimum: it drops
// straight to anything quieter, and creeps back up toward the level while the
// detector says nobody is speaking. It ends up sitting on the room tone, which
// is what the bottom of the range should mean.
const FLOW_BUCKETS = 16; // levels[FLOW_BUCKETS] is the dBFS the recorder rides along
const FLOW_SPEECH = 17; // levels[FLOW_SPEECH] is 1 while the VAD is passing frames
// How many level packets in a row have to disagree before the bar is pulled
// down. Packets arrive about every 33ms, so two is ~66ms — long enough for the
// VAD to have had its say, short enough that a suppressed twitch reads as the
// bar settling rather than as a lag. Nothing gates the rise: sound moves the
// bar on the very first packet, and only staying un-voiced takes it away.
const FLOW_SUPPRESS_AFTER_PACKETS = 2;
const FLOW_FLOOR_MIN_DB = -70;
const FLOW_FLOOR_MAX_DB = -25;
// Wispr reads the level over a fixed 20 dB above the floor, which assumes 20 dB
// between a room and a voice. Measured across all 915 of Rem's recordings —
// 11 hours — the gap between his quiet frames and his speech has a median of
// 12.4 dB and a 5th percentile of 6.8; 94% of them sit under 20. So on his
// audio that constant fills the bar in 13.7% of recordings and leaves the
// median at 0.62, which is the bar using two thirds of its height at his
// loudest.
//
// So the span is learned, not assumed: it opens to any speech peak further above
// the floor than the current span, and closes at about 3 dB a second otherwise.
// Simulated over that same corpus this reaches the top of the bar in 94% of
// recordings (median 0.99, 5th percentile 0.83). Closing more slowly is what
// held the first attempt at this to 41% — a span inherited from a loud moment
// took half a minute to come back down.
// Where a recording starts. Overwritten from settings by the tuner, which
// derives it from the recordings on this machine — a span that suits one voice
// and one room suits nobody else's.
let flowSpanInitDb = 10;
const FLOW_SPAN_MIN_DB = 8; // 90% of recordings have more contrast than this
const FLOW_SPAN_MAX_DB = 24; // and 100% have less than this
const FLOW_SPAN_OPEN = 0.3; // fraction of the gap to a louder peak, per packet
const FLOW_SPAN_CLOSE_DB = 0.1; // dB conceded per packet, ~3 dB a second
// Per packet, while un-voiced: how much of the gap to the current level the
// floor closes. At ~30 packets a second this settles on a room in a second or
// two, then holds.
const FLOW_FLOOR_LEARN = 0.05;
let flowFloorDb = FLOW_FLOOR_MAX_DB;
let flowSpanDb = flowSpanInitDb;

const FLOW_BAR_STYLE: React.CSSProperties[] = Array.from(
  { length: FLOW_BARS },
  (_, i) => {
    const distance = Math.abs((FLOW_BARS - 1) / 2 - i);
    const half = Math.ceil(FLOW_BARS / 2);
    return {
      "--bar-height-scale": Math.max(0, 1 - Math.pow(distance, 2) * FLOW_BULGE),
      animationDelay: `${0.1 * (i < half ? i : i - FLOW_BARS)}s`,
    } as React.CSSProperties;
  },
);

// The working spinner: eight ticks on a 16px circle, each 45 degrees round and
// pushed 6px out from the centre, fading in sequence over 1.1s.
const FLOW_SPINNER_TICKS = 8;
const FLOW_SPINNER_STYLE: React.CSSProperties[] = Array.from(
  { length: FLOW_SPINNER_TICKS },
  (_, i) => ({
    transform: `rotate(${45 * i}deg) translate(0, -6px)`,
    animationDelay: `${-0.1375 * (FLOW_SPINNER_TICKS - 1 - i)}s`,
  }),
);

const RecordingOverlay: React.FC = () => {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<OverlayState>("recording");
  // `Stream::play()` returning does not mean hardware callbacks are flowing.
  // Stay visually in an arming state until the backend processes the first
  // actual microphone sample chunk.
  const [captureReady, setCaptureReady] = useState(false);
  const [streamText, setStreamText] = useState<StreamTextEvent>({
    committed: "",
    tentative: "",
  });
  const [phase, setPhase] = useState<StreamPhase>("listening");
  const [workKind, setWorkKind] = useState<StreamWorkKind>("transcribing");
  const [elapsed, setElapsed] = useState(0);
  // Bumped on each new streaming session so the Live card remounts fresh (replays
  // the pop-in, and never animates in from the previous panel's open size).
  const [session, setSession] = useState(0);
  // Overlay placement (top vs bottom of the screen). The Live panel grows downward
  // from a top overlay (oldest line under the pill) and upward from a bottom one.
  const [position, setPosition] = useState<"top" | "bottom">("bottom");
  // True once live text overflows the cap. A top overlay fades its top edge only
  // while overflowing, so the resting first line stays crisp flush under the pill.
  const [overflowing, setOverflowing] = useState(false);

  // Flow bar: the raw loudness the mic reported last, and the element whose
  // --audio-scale every bar reads from.
  const flowLevelRef = useRef(0);
  const flowWaveRef = useRef<HTMLDivElement>(null);
  // Mirrors captureReady so the level listener can clear the arming state
  // without a set-state call on every packet.
  const captureReadyRef = useRef(false);
  // Consecutive packets the VAD has not called speech, and whether the last one
  // tipped into suppression.
  const unvoicedRunRef = useRef(0);
  const flowSuppressedRef = useRef(false);
  // Live-text scroll-back: the text region "sticks" to the newest line while the
  // user is at the bottom; if they scroll up to read history, auto-follow pauses
  // until they scroll back down.
  const capRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const direction = getLanguageDirection(i18n.language);

  useEffect(() => {
    const setupEventListeners = async () => {
      const unlistenShow = await listen("show-overlay", async (event) => {
        const overlayState = event.payload as OverlayState;
        // Reset synchronously before settings I/O. A fast microphone can emit
        // recording-ready while the awaits below are in flight; resetting after
        // them would overwrite that event and leave the overlay stuck arming.
        if (overlayState === "recording" || overlayState === "streaming") {
          captureReadyRef.current = false;
          unvoicedRunRef.current = 0;
          flowSuppressedRef.current = false;
          // The floor and span deliberately survive between recordings. A room
          // does not change because a recording ended, so starting the next one
          // from what the last one learned is the same thing as knowing the
          // ambient up front — without holding the microphone open between
          // takes to go and measure it. Both still converge within about a
          // second if the room really has changed.
          setCaptureReady(false);
          setStreamText({ committed: "", tentative: "" });
        }

        await syncLanguageFromSettings();
        // The Live panel flows downward from a top overlay and upward from a
        // bottom one; read the placement so the layout can flip to match.
        try {
          const settings = await commands.getAppSettings();
          if (settings.status === "ok") {
            setPosition(
              settings.data.overlay_position === "top" ? "top" : "bottom",
            );
            const tuned = settings.data.flow_span_init_db;
            if (typeof tuned === "number" && tuned > 0) {
              flowSpanInitDb = tuned;
              flowSpanDb = tuned;
            }
          }
        } catch {
          // Keep the previous/default placement if settings can't be read.
        }
        setState(overlayState);
        if (overlayState === "streaming") {
          setPhase("listening");
          setWorkKind("transcribing");
          setElapsed(0);
          setSession((s) => s + 1); // remount the card fresh for this session
        }
        setIsVisible(true);
      });

      const unlistenHide = await listen("hide-overlay", () => {
        setIsVisible(false);
        captureReadyRef.current = false;
        setCaptureReady(false);
      });

      const unlistenReady = await listen("recording-ready", () => {
        setElapsed(0);
        captureReadyRef.current = true;
        setCaptureReady(true);
      });

      const unlistenLevel = await listen<number[]>("mic-level", (event) => {
        // The payload is the 16 FFT buckets with the window's dBFS appended.
        // Let the floor settle to the quietest thing heard, then read the level
        // off it. Smoothing happens on the render loop, not here.
        const payload = event.payload as number[];
        const db = payload[FLOW_BUCKETS];
        if (db === undefined) return;
        // Levels only flow from a live microphone, so this is proof of capture
        // in its own right — and unlike `recording-ready` it cannot be missed.
        // With a quiet window configured the overlay is shown *after* readiness
        // fires, and the reset above would otherwise strand the bar arming for
        // the whole recording.
        if (!captureReadyRef.current) {
          captureReadyRef.current = true;
          setCaptureReady(true);
        }
        const speech = payload[FLOW_SPEECH];
        const voiced = speech === undefined || speech > 0;
        if (db < flowFloorDb) {
          // Anything quieter than the floor IS the floor.
          flowFloorDb = Math.max(FLOW_FLOOR_MIN_DB, db);
        } else if (!voiced) {
          // Nobody is talking, so this is the room: let the floor rise to it.
          flowFloorDb = Math.min(
            FLOW_FLOOR_MAX_DB,
            flowFloorDb + (db - flowFloorDb) * FLOW_FLOOR_LEARN,
          );
        }
        if (voiced) {
          // Only a voice widens the range; a door slam must not rescale the bar
          // for the rest of the recording.
          const gap = db - flowFloorDb;
          flowSpanDb =
            gap > flowSpanDb
              ? flowSpanDb + (gap - flowSpanDb) * FLOW_SPAN_OPEN
              : flowSpanDb - FLOW_SPAN_CLOSE_DB;
          flowSpanDb = Math.min(
            FLOW_SPAN_MAX_DB,
            Math.max(FLOW_SPAN_MIN_DB, flowSpanDb),
          );
        }
        const level = Math.min(1, Math.max(0, (db - flowFloorDb) / flowSpanDb));
        // A room is not a voice. The recorder marks the windows its VAD passed;
        // sustained disagreement pulls the bar down, but the first packets of
        // any sound always get through, so the bar never lags a real voice.
        if (voiced) {
          unvoicedRunRef.current = 0;
        } else {
          unvoicedRunRef.current += 1;
        }
        const suppressed = unvoicedRunRef.current > FLOW_SUPPRESS_AFTER_PACKETS;
        flowLevelRef.current = suppressed ? 0 : level;
        // Suppression is a decision, not a fade: don't let the slew spend
        // another 170ms walking a saturated level down to nothing.
        if (suppressed) flowSuppressedRef.current = true;
      });

      const unlistenStream = await events.streamTextEvent.listen((event) => {
        setStreamText(event.payload);
      });

      const unlistenPhase = await events.streamPhaseEvent.listen((event) => {
        const payload: StreamPhaseEvent = event.payload;
        setPhase(payload.phase);
        if (payload.kind) setWorkKind(payload.kind);
      });

      return () => {
        unlistenShow();
        unlistenHide();
        unlistenReady();
        unlistenLevel();
        unlistenStream();
        unlistenPhase();
      };
    };

    setupEventListeners();
  }, []);

  // Elapsed capture timer starts only once microphone samples are flowing.
  useEffect(() => {
    if (state !== "streaming" || !isVisible || !captureReady) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [state, isVisible, captureReady]);

  // Drive the flow bar's --audio-scale on its own frame loop rather than from
  // React state: the bars are CSS transforms, so a per-frame variable write
  // costs one style recalc instead of a re-render per mic packet.
  useEffect(() => {
    if (!isVisible) return;
    let raf = 0;
    let last: number | null = null;
    let smoothed = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const el = flowWaveRef.current;
      if (!el) return;
      const dt = Math.min(
        Math.max(last === null ? FLOW_FRAME_MS : now - last, 1),
        200,
      );
      last = now;
      const blend = Math.pow(FLOW_BLEND, dt / FLOW_FRAME_MS);
      const blended = smoothed * blend + flowLevelRef.current * (1 - blend);
      if (flowSuppressedRef.current) {
        // The verdict said stop; the bar stops.
        flowSuppressedRef.current = false;
        smoothed = 0;
      } else {
        const rising = blended > smoothed;
        const limit = (dt / 1000) * (rising ? FLOW_SLEW : FLOW_SLEW_FALL);
        const step = Math.min(limit, Math.max(-limit, blended - smoothed));
        smoothed = Math.floor((smoothed + step) * 100) / 100;
      }
      el.style.setProperty(
        "--audio-scale",
        String(Math.max(1, FLOW_GAIN * smoothed)),
      );
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isVisible]);

  // Stick to the bottom as text streams in — but only while pinned, so a user who
  // has scrolled up to read history isn't yanked back down by the next chunk.
  useLayoutEffect(() => {
    const el = capRef.current;
    if (!el) return;
    // Fade the top edge only once text actually overflows the cap.
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [streamText]);

  // Each fresh streaming session starts pinned to the bottom, fade cleared.
  useEffect(() => {
    pinnedRef.current = true;
    setOverflowing(false);
  }, [session]);

  if (!isVisible) return null;

  // Re-pin when the user is within ~a line of the bottom; unpin otherwise.
  const handleStreamScroll = () => {
    const el = capRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
  };

  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // ---- Shared building blocks (one visual language for every overlay form) ----
  // Flow-bar waveform: ten bars whose scale comes entirely from CSS (the shared
  // --audio-scale on this element, times each bar's own bulge factor). Until the
  // first microphone callback lands the bars are muted, so the bar acknowledges
  // the shortcut without pretending it is already hearing anything.
  const flowWave = (
    <div ref={flowWaveRef} className={`wwave ${captureReady ? "" : "arming"}`}>
      {FLOW_BAR_STYLE.map((barStyle, i) => (
        <i key={i} style={barStyle} />
      ))}
    </div>
  );

  const flowSpinner = (
    <span className="wspinner">
      {FLOW_SPINNER_STYLE.map((tickStyle, i) => (
        <i key={i} style={tickStyle} />
      ))}
    </span>
  );

  const cancelBtn = (
    <button
      className="sx"
      aria-label="cancel"
      onClick={() => commands.cancelOperation()}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 4 L12 12 M12 4 L4 12"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );

  // dot (left) | waveform (center) | timer + cancel (right) — same structure for
  // pill & panel, so the Live morph is a pure width change.
  const listeningRow = (showTimer: boolean, showCancel: boolean) => (
    <div className="sbase">
      <div className="sbase-l">
        <span className={`sdot ${captureReady ? "ready" : "arming"}`} />
      </div>
      {flowWave}
      <div className="sbase-r">
        {showTimer && <span className="stimer">{fmtTime(elapsed)}</span>}
        {showCancel && cancelBtn}
      </div>
    </div>
  );

  // spinner (left) | label (center) | cancel (right) — same 3-zone grid as the
  // listening row, so the label is centered.
  const workingRow = (label: string, showCancel: boolean) => (
    <div className="sbase">
      <div className="sbase-l">
        <span className="sspinner" />
      </div>
      <span className="swork-label">{label}</span>
      <div className="sbase-r">{showCancel && cancelBtn}</div>
    </div>
  );

  // ---- Live overlay: a pill that sculpts open into a panel ----
  if (state === "streaming") {
    const hasText =
      streamText.committed.length > 0 || streamText.tentative.length > 0;
    const working = phase === "working";
    // Keep the panel open whenever there's text — even while finalizing — so the
    // transcript stays put under a working spinner instead of collapsing and
    // squishing the text mid-stream. Only fall back to the small working pill
    // when there was no text to preserve.
    const open = hasText;
    const collapsed = working && !hasText;

    return (
      <div dir={direction} className={`ov-stage ${position}`}>
        <div
          key={session}
          className={`scard ${open ? "open" : ""} ${collapsed ? "working" : ""} ${
            isVisible ? "" : "leaving"
          }`}
        >
          <div className="stext">
            <div className="stext-clip">
              <div
                className={`stext-cap ${overflowing ? "overflowing" : ""}`}
                ref={capRef}
                onScroll={handleStreamScroll}
              >
                <p>
                  <span className="committed">
                    {streamText.committed ? streamText.committed + " " : ""}
                  </span>
                  <span className="tentative">{streamText.tentative}</span>
                  {/* Drop the blinking caret once finalizing — it's no longer
                      capturing, and a static spinner conveys the work. */}
                  {!working && <span className="scaret" />}
                </p>
              </div>
            </div>
          </div>
          {working
            ? workingRow(
                workKind === "polishing"
                  ? t("overlay.processing")
                  : t("overlay.transcribing"),
                true,
              )
            : listeningRow(open, true)}
        </div>
      </div>
    );
  }

  // ---- Minimal overlay: the flow bar. A fixed-size capsule per state — 73x30
  // while the mic is open, 98x30 while it works, each reached in 100ms from the
  // 40x8 nub it enters as. Clicking it cancels, as it did before.
  const working = state === "transcribing" || state === "processing";

  return (
    <div
      dir={direction}
      className={`ov-stage ${position} ov-fade ${isVisible ? "show" : ""}`}
    >
      <div
        className={`wpill ${working ? "working" : "recording"}`}
        onClick={() => commands.cancelOperation()}
      >
        <div className="wrow">
          {flowWave}
          {working && flowSpinner}
        </div>
      </div>
    </div>
  );
};

export default RecordingOverlay;
