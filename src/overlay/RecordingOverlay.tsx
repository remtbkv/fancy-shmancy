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
// Loudness → level, lifted from Wispr Flow's main process verbatim: keep a floor
// that only ever descends to the quietest dB this run has seen (never below
// -60 dBFS), and read the level as how far above that floor the current window
// sits, over a 20 dB span. Nothing here is tuned to a particular mic — a loud
// setup and a quiet one both end up using the same top of the range, which is
// the point. The floor lives outside the component so it survives across
// recordings, as Wispr's does across a session.
const FLOW_BUCKETS = 16; // levels[FLOW_BUCKETS] is the dBFS the recorder rides along
const FLOW_SPEECH = 17; // levels[FLOW_SPEECH] is 1 while the VAD is passing frames
// How many level packets in a row have to disagree before the bar is pulled
// down. Packets arrive about every 33ms, so two is ~66ms — long enough for the
// VAD to have had its say, short enough that a suppressed twitch reads as the
// bar settling rather than as a lag. Nothing gates the rise: sound moves the
// bar on the very first packet, and only staying un-voiced takes it away.
const FLOW_SUPPRESS_AFTER_PACKETS = 2;
const FLOW_FLOOR_MIN_DB = -60;
const FLOW_RANGE_DB = 20;
let flowFloorDb = 0;

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
  // Consecutive packets the VAD has not called speech.
  const unvoicedRunRef = useRef(0);
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
        if (db < flowFloorDb) flowFloorDb = Math.max(FLOW_FLOOR_MIN_DB, db);
        const level = Math.min(
          1,
          Math.max(0, (db - flowFloorDb) / FLOW_RANGE_DB),
        );
        // A room is not a voice. The recorder marks the windows its VAD passed;
        // sustained disagreement pulls the bar down, but the first packets of
        // any sound always get through, so the bar never lags a real voice.
        // Falling back to reacting when the flag is absent keeps this working
        // against a build that doesn't send it.
        const speech = payload[FLOW_SPEECH];
        if (speech === undefined || speech > 0) {
          unvoicedRunRef.current = 0;
        } else {
          unvoicedRunRef.current += 1;
        }
        const suppressed = unvoicedRunRef.current > FLOW_SUPPRESS_AFTER_PACKETS;
        flowLevelRef.current = suppressed ? 0 : level;
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
      const rising = blended > smoothed;
      const limit = (dt / 1000) * (rising ? FLOW_SLEW : FLOW_SLEW_FALL);
      const step = Math.min(limit, Math.max(-limit, blended - smoothed));
      smoothed = Math.floor((smoothed + step) * 100) / 100;
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
