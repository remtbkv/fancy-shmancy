import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, X } from "lucide-react";

/**
 * The controls the reference uses on the right-hand side of a `SettingRow`
 * that a Toggle or a `Change` PillButton cannot cover: a select, a number
 * field, a volume range and a chip list.
 *
 * Geometry is sampled from the reference's own `App Language` select
 * (screenshot 2 — native 2008–2339 x 1120–1195 = 165.5 x 37.5 css): a white
 * field on the cream card, 1px hairline border, the pill's 8px radius, ~14px
 * horizontal padding, and an ink-muted chevron ~7.5 css wide. Width follows
 * the measured 164px control column so a card's controls line up. The menu
 * itself is not visible in any reference screenshot, so its surface reuses the
 * modal's white + hairline + 8px radius and the measured `--fs-quiet`
 * selected fill rather than inventing a new skin.
 */
const FIELD_H = "38px";
const FIELD_W = "164px";
const FIELD_PX = "14px";

export interface FieldOption {
  value: string;
  label: string;
}

const fieldSkin: React.CSSProperties = {
  height: FIELD_H,
  borderRadius: "var(--fs-radius-pill)",
  background: "var(--fs-modal)",
  border: "1px solid var(--fs-hairline)",
  fontFamily: "var(--fs-font-sans)",
  fontSize: "var(--fs-text-body)",
  color: "var(--fs-ink)",
};

interface FieldSelectProps {
  options: FieldOption[];
  value: string | null;
  onSelect: (value: string) => void;
  /** Shown when nothing matches `value` — a loading or empty list. */
  placeholder?: string;
  disabled?: boolean;
  /** Adds a filter box above the list; for the ~100-entry language list. */
  searchable?: boolean;
  /** Called before the menu opens, so a device list can be re-enumerated. */
  onOpen?: () => void;
  /** Let the field grow past the control column for long device names. */
  wide?: boolean;
}

export const FieldSelect: React.FC<FieldSelectProps> = ({
  options,
  value,
  onSelect,
  placeholder,
  disabled = false,
  searchable = false,
  onOpen,
  wide = false,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [anchor, setAnchor] = useState<{
    right: number;
    top?: number;
    bottom?: number;
    minWidth: number;
    maxHeight: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    // On document, not on the menu: the trigger keeps focus while the menu is
    // open, so a React handler inside it would never see the key. The modal's
    // own Escape handler skips while `data-fs-menu-open` is in the DOM, which
    // is what makes the first Escape close the menu and the second the modal.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // The menu is anchored in viewport coordinates, so anything that moves the
    // trigger dismisses it rather than leaving it stranded.
    const dismiss = () => setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  // Rendered into the body: a settings card clips its own overflow, so a menu
  // laid out inside the card would be cut off at its edge.
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const box = triggerRef.current?.getBoundingClientRect();
    if (!box) return;
    // Open downwards unless there is materially more room above; either way the
    // list is capped to the space that is actually there, so a long list
    // scrolls inside the menu instead of running off the window.
    const below = window.innerHeight - box.bottom - 12;
    const above = box.top - 12;
    const openUp = below < 200 && above > below;
    setAnchor({
      right: Math.max(8, window.innerWidth - box.right),
      top: openUp ? undefined : box.bottom + 4,
      bottom: openUp ? window.innerHeight - box.top + 4 : undefined,
      minWidth: box.width,
      maxHeight: Math.max(120, Math.min(320, openUp ? above : below)),
    });
    if (searchable) searchRef.current?.focus();
  }, [open, searchable]);

  const selected = options.find((option) => option.value === value);
  const shown = query
    ? options.filter((option) =>
        option.label.toLowerCase().includes(query.toLowerCase()),
      )
    : options;

  const choose = (next: string) => {
    onSelect(next);
    setOpen(false);
    setQuery("");
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (!open) onOpen?.();
          setOpen(!open);
        }}
        className={`flex items-center justify-between gap-[8px] text-left transition-colors
          disabled:cursor-not-allowed disabled:opacity-50
          ${disabled ? "" : "cursor-pointer hover:bg-[var(--fs-row-hover)]"}`}
        style={{
          ...fieldSkin,
          width: wide ? "220px" : FIELD_W,
          paddingInline: FIELD_PX,
          transitionDuration: "var(--fs-enter)",
        }}
      >
        <span className="truncate">{selected?.label ?? placeholder ?? ""}</span>
        <ChevronDown
          size={14}
          aria-hidden
          style={{ color: "var(--fs-ink-muted)", flexShrink: 0 }}
        />
      </button>

      {open &&
        !disabled &&
        anchor &&
        createPortal(
          <div
            ref={menuRef}
            data-fs-menu-open
            className="fixed z-[60] flex flex-col overflow-hidden"
            style={{
              right: anchor.right,
              top: anchor.top,
              bottom: anchor.bottom,
              minWidth: anchor.minWidth,
              maxWidth: "320px",
              width: "max-content",
              maxHeight: anchor.maxHeight,
              background: "var(--fs-modal)",
              border: "1px solid var(--fs-hairline)",
              borderRadius: "var(--fs-radius-pill)",
              boxShadow: "0 8px 40px rgba(0, 0, 0, 0.10)",
              fontFamily: "var(--fs-font-sans)",
            }}
          >
            {searchable && (
              <div
                className="shrink-0 p-[8px]"
                style={{ borderBottom: "1px solid var(--fs-hairline)" }}
              >
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && shown.length > 0) {
                      choose(shown[0].value);
                    }
                  }}
                  placeholder={t("settings.general.language.searchPlaceholder")}
                  className="w-full outline-none"
                  style={{
                    height: "28px",
                    paddingInline: "8px",
                    borderRadius: "var(--fs-radius-item)",
                    background: "var(--fs-inset)",
                    fontSize: "var(--fs-text-body)",
                    color: "var(--fs-ink)",
                  }}
                />
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto py-[4px]">
              {shown.length === 0 ? (
                <div
                  className="px-[12px] py-[6px]"
                  style={{
                    fontSize: "var(--fs-text-body)",
                    color: "var(--fs-ink-muted)",
                  }}
                >
                  {t("common.noOptionsFound")}
                </div>
              ) : (
                shown.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => choose(option.value)}
                    className="flex w-full cursor-pointer items-center px-[12px] text-left hover:bg-[var(--fs-row-hover)]"
                    style={{
                      minHeight: "30px",
                      fontSize: "var(--fs-text-body)",
                      fontWeight: option.value === value ? 600 : 400,
                      background:
                        option.value === value ? "var(--fs-quiet)" : undefined,
                      color: "var(--fs-ink)",
                    }}
                  >
                    {option.label}
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};

interface NumberFieldProps {
  value: number;
  /** Unit shown after the field — "GB", "minutes", "ms". */
  unit: string;
  onCommit: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  /** Fixed decimals for the displayed value; storage caps use 1. */
  decimals?: number;
}

/**
 * A number the field only stores on the way out — the same draft-then-commit
 * behaviour the existing settings inputs use, so typing never fights the
 * caret and an emptied field lands back inside the range.
 */
export const NumberField: React.FC<NumberFieldProps> = ({
  value,
  unit,
  onCommit,
  min,
  max,
  step = 1,
  disabled = false,
  decimals = 0,
}) => {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const typed = parseFloat(draft);
    const next = Number.isNaN(typed)
      ? min
      : Math.min(Math.max(typed, min), max);
    setDraft(null);
    if (next !== value) onCommit(next);
  };

  return (
    <div className="flex items-center gap-[8px]">
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={draft ?? value.toFixed(decimals)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="text-right outline-none disabled:opacity-50"
        style={{ ...fieldSkin, width: "84px", paddingInline: "10px" }}
      />
      <span
        style={{
          fontFamily: "var(--fs-font-sans)",
          fontSize: "var(--fs-text-body)",
          color: "var(--fs-ink-secondary)",
        }}
      >
        {unit}
      </span>
    </div>
  );
};

interface RangeFieldProps {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  label: string;
}

/**
 * Volume. No reference screenshot shows a slider, so this is the measured
 * palette applied to the platform control: an ink track at the control
 * column's width.
 */
export const RangeField: React.FC<RangeFieldProps> = ({
  value,
  onChange,
  disabled = false,
  label,
}) => (
  <input
    type="range"
    min={0}
    max={1}
    step={0.05}
    value={value}
    disabled={disabled}
    aria-label={label}
    onChange={(event) => onChange(parseFloat(event.target.value))}
    className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
    style={{ width: FIELD_W, accentColor: "var(--fs-ink)" }}
  />
);

interface TagListProps {
  items: string[];
  onRemove: (item: string) => void;
  removeLabel: (item: string) => string;
  disabled?: boolean;
}

/**
 * The chips under a row that keeps a list — custom words, typed-out apps.
 * Sits inside the card below its row, on the card's own padding, so the list
 * belongs to the row above it rather than reading as a new setting.
 */
export const TagList: React.FC<TagListProps> = ({
  items,
  onRemove,
  removeLabel,
  disabled = false,
}) => {
  if (items.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-[6px] border-b border-[var(--fs-hairline)] last:border-b-0"
      style={{
        paddingInline: "var(--fs-row-px)",
        paddingBlock: "16px",
      }}
    >
      {items.map((item) => (
        <button
          key={item}
          type="button"
          disabled={disabled}
          onClick={() => onRemove(item)}
          aria-label={removeLabel(item)}
          className="inline-flex cursor-pointer items-center gap-[6px] transition-colors
            hover:bg-[var(--fs-quiet-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            height: "28px",
            paddingInline: "10px",
            borderRadius: "var(--fs-radius-item)",
            background: "var(--fs-quiet)",
            fontFamily: "var(--fs-font-sans)",
            fontSize: "var(--fs-text-body)",
            color: "var(--fs-ink)",
          }}
        >
          <span>{item}</span>
          <X size={12} aria-hidden />
        </button>
      ))}
    </div>
  );
};

interface TextFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  onSubmit?: () => void;
  ariaLabel: string;
  width?: string;
}

export const TextField: React.FC<TextFieldProps> = ({
  value,
  onChange,
  placeholder,
  disabled = false,
  onSubmit,
  ariaLabel,
  width = FIELD_W,
}) => (
  <input
    type="text"
    value={value}
    disabled={disabled}
    aria-label={ariaLabel}
    placeholder={placeholder}
    onChange={(event) => onChange(event.target.value)}
    onKeyDown={(event) => {
      if (event.key === "Enter" && onSubmit) {
        event.preventDefault();
        onSubmit();
      }
    }}
    className="outline-none disabled:opacity-50"
    style={{ ...fieldSkin, width, paddingInline: "10px" }}
  />
);

interface IconActionProps {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
}

/** A quiet square button for a row's secondary action (preview, reset). */
export const IconAction: React.FC<IconActionProps> = ({
  onClick,
  label,
  disabled = false,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    title={label}
    className="flex shrink-0 cursor-pointer items-center justify-center transition-colors
      hover:bg-[var(--fs-quiet)] disabled:cursor-not-allowed disabled:opacity-40"
    style={{
      width: "var(--fs-control-h)",
      height: "var(--fs-control-h)",
      borderRadius: "var(--fs-radius-pill)",
      color: "var(--fs-ink-muted)",
    }}
  >
    {children}
  </button>
);
