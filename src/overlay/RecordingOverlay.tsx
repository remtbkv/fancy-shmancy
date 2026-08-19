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
const FLOW_SLEW = 1.6; // max level change per second
// Wispr's gain assumes a loudness that reaches 1 on speech. Handy's loudest FFT
// bucket only reached ~0.35 on the same dictation — measured off a screen
// recording with both bars in it, where Wispr's bars threw 10-14pt and these
// threw 3-4pt. This lifts Handy's scale onto Wispr's without touching the gain,
// the floor, or the ceiling, so the two bars move through the same range.
const FLOW_LEVEL_TRIM = 2.9;

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
  // Live-text scroll-back: the text region "sticks" to the newest line while the
  // user is at the bottom; if they scroll up to read history, auto-follow pauses
  // until they scroll back down.
  const capRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const direction = getLanguageDirection(i18n.language);

  useEffect(() => {
    const setupEventListeners = async () => {
      const unlistenShow = await listen("show-overlay", async (event) => {
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
        const overlayState = event.payload as OverlayState;
        setState(overlayState);
        if (overlayState === "recording" || overlayState === "streaming") {
          setStreamText({ committed: "", tentative: "" });
        }
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
      });

      const unlistenLevel = await listen<number[]>("mic-level", (event) => {
        // Mic levels arrive as 16 log-spaced FFT buckets, each already curved
        // into 0-1. The flow bar wants one loudness number: take the loudest
        // bucket, not the mean — speech energy sits in a handful of low buckets,
        // so averaging across all sixteen buries it and the bar barely moves.
        // Smoothing happens on the render loop, not here.
        const newLevels = event.payload as number[];
        let peak = 0;
        for (const v of newLevels) if (v > peak) peak = v;
        flowLevelRef.current = peak;
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
        unlistenLevel();
        unlistenStream();
        unlistenPhase();
      };
    };

    setupEventListeners();
  }, []);

  // Elapsed timer while the Live overlay is visible.
  useEffect(() => {
    if (state !== "streaming" || !isVisible) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [state, isVisible]);

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
      const limit = (dt / 1000) * FLOW_SLEW;
      const step = Math.min(limit, Math.max(-limit, blended - smoothed));
      smoothed = Math.floor((smoothed + step) * 100) / 100;
      const scale = FLOW_GAIN * Math.min(1, smoothed * FLOW_LEVEL_TRIM);
      el.style.setProperty("--audio-scale", String(Math.max(1, scale)));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isVisible]);

  // The capsule enters at its resting size and is given the live state on the
  // next frame, so the 100ms transition plays the grow instead of the bar just
  // appearing at full size.
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    if (!isVisible) {
      setGrown(false);
      return;
    }
    const raf = requestAnimationFrame(() => setGrown(true));
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
  // --audio-scale on this element, times each bar's own bulge factor).
  const flowWave = (
    <div ref={flowWaveRef} className="wwave">
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
        <span className="sdot" />
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
        className={`wpill ${grown ? (working ? "working" : "recording") : ""}`}
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
