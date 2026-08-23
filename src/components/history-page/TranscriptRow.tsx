import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Copy,
  MoreVertical,
  Pause,
  Play,
  RotateCcw,
  Star,
  Trash2,
} from "lucide-react";
import type { HistoryEntry } from "@/bindings";
import { formatClockTime } from "./format";

interface TranscriptRowProps {
  entry: HistoryEntry;
  playing: boolean;
  onTogglePlay: () => void;
  onCopy: () => void;
  onToggleSaved: () => void;
  onRetry: () => void;
  onDelete: () => void;
}

const ICON = { size: 17, strokeWidth: 1.5 } as const;

const RowAction: React.FC<{
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ label, onClick, disabled, children }) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
    className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center
      rounded-[var(--fs-radius-item)] disabled:cursor-not-allowed disabled:opacity-40
      hover:bg-[var(--fs-quiet)]"
    style={{ color: "var(--fs-ink)" }}
  >
    {children}
  </button>
);

const MenuItem: React.FC<{
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex h-[32px] w-full cursor-pointer items-center gap-[8px] px-[12px]
      text-left hover:bg-[var(--fs-row-hover)]"
    style={{
      fontFamily: "var(--fs-font-sans)",
      fontSize: "var(--fs-text-body)",
      color: "var(--fs-ink)",
    }}
  >
    {children}
    <span className="truncate">{label}</span>
  </button>
);

/**
 * One transcript: `52` tall, a `97` timestamp column at 13px muted ink, the
 * text at 15px, and play / copy / menu revealed on hover with no transition
 * (MOTION.md). The action strip carries the row's own hover fill so it covers
 * the text end rather than reflowing the row.
 */
export const TranscriptRow: React.FC<TranscriptRowProps> = ({
  entry,
  playing,
  onTogglePlay,
  onCopy,
  onToggleSaved,
  onRetry,
  onDelete,
}) => {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAbove, setMenuAbove] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLDivElement>(null);

  const hasText = entry.transcription_text.trim().length > 0;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuOpen]);

  const handleCopy = () => {
    if (!hasText) return;
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const openMenu = () => {
    // Flip upwards near the bottom of the window so the card doesn't clip it.
    const rect = menuButtonRef.current?.getBoundingClientRect();
    setMenuAbove(!!rect && rect.bottom + 140 > window.innerHeight);
    setMenuOpen((open) => !open);
  };

  const runFromMenu = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

  return (
    <div
      className="group relative flex items-center hover:bg-[var(--fs-row-hover)]"
      style={{
        // 52 of row plus the divider: border-box would otherwise take the
        // hairline out of the 52 and give a 52 pitch where the reference
        // measures 53 (fills of 104 native at a pitch of 106).
        height: "53px",
        paddingInline: "16px",
        borderTop: "1px solid var(--fs-hairline-soft)",
      }}
    >
      <span
        className="shrink-0"
        style={{
          width: "97px",
          fontFamily: "var(--fs-font-sans)",
          fontSize: "var(--fs-text-meta)",
          color: "var(--fs-ink-muted)",
        }}
      >
        {formatClockTime(entry.timestamp, i18n.language)}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        style={{
          fontFamily: "var(--fs-font-sans)",
          fontSize: "var(--fs-text-body)",
          color: hasText ? "var(--fs-ink-secondary)" : "var(--fs-ink-muted)",
        }}
      >
        {hasText
          ? entry.transcription_text
          : entry.cancelled
            ? t("shell.transcripts.cancelled")
            : t("shell.transcripts.failed")}
      </span>

      <div
        className="absolute inset-y-0 end-0 hidden items-center gap-[6px] pe-[16px] ps-[24px] group-hover:flex"
        style={{ background: "var(--fs-row-hover)" }}
      >
        <RowAction
          label={
            playing ? t("shell.transcripts.pause") : t("shell.transcripts.play")
          }
          onClick={onTogglePlay}
        >
          {playing ? <Pause {...ICON} /> : <Play {...ICON} />}
        </RowAction>
        <RowAction
          label={
            copied ? t("shell.transcripts.copied") : t("shell.transcripts.copy")
          }
          onClick={handleCopy}
          disabled={!hasText}
        >
          {copied ? <Check {...ICON} /> : <Copy {...ICON} />}
        </RowAction>
        <div ref={menuButtonRef} className="relative">
          <RowAction label={t("shell.transcripts.more")} onClick={openMenu}>
            <MoreVertical {...ICON} />
          </RowAction>
          {menuOpen && (
            <div
              ref={menuRef}
              className={`absolute end-0 z-20 w-[196px] overflow-hidden py-[4px]
                ${menuAbove ? "bottom-[32px]" : "top-[32px]"}`}
              style={{
                background: "var(--fs-modal)",
                border: "1px solid var(--fs-hairline)",
                borderRadius: "var(--fs-radius-pill)",
                boxShadow: "0 8px 40px rgba(0, 0, 0, 0.10)",
                animation: "fs-fade-in var(--fs-enter) ease-out",
              }}
            >
              <MenuItem
                label={
                  entry.saved
                    ? t("shell.transcripts.unsave")
                    : t("shell.transcripts.save")
                }
                onClick={runFromMenu(onToggleSaved)}
              >
                <Star {...ICON} fill={entry.saved ? "currentColor" : "none"} />
              </MenuItem>
              <MenuItem
                label={t("shell.transcripts.retranscribe")}
                onClick={runFromMenu(onRetry)}
              >
                <RotateCcw {...ICON} />
              </MenuItem>
              <MenuItem
                label={t("shell.transcripts.delete")}
                onClick={runFromMenu(onDelete)}
              >
                <Trash2 {...ICON} />
              </MenuItem>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
