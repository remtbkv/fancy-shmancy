import React, { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Plus, RotateCcw, X } from "lucide-react";
import { formatKeyCombination } from "../../lib/utils/keyboard";
import { KeycapPill } from "../ui/KeycapPill";
import { ResetButton } from "../ui/ResetButton";
import { IconAction } from "./modal/controls";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import { useOsType } from "../../hooks/useOsType";
import { commands } from "@/bindings";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SECURE_INPUT_HELP_URL } from "../SecureInputWarning";

interface HandyKeysShortcutInputProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  shortcutId: string;
  disabled?: boolean;
  /** See `ShortcutInput`: `none` renders the recorder without its container. */
  chrome?: "container" | "none";
}

interface HandyKeysEvent {
  modifiers: string[];
  key: string | null;
  is_key_down: boolean;
  hotkey_string: string;
}

export const HandyKeysShortcutInput: React.FC<HandyKeysShortcutInputProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
  shortcutId,
  disabled = false,
  chrome = "container",
}) => {
  const { t } = useTranslation();
  const {
    getSetting,
    setBindingShortcuts,
    resetBinding,
    isUpdating,
    isLoading,
  } = useSettings();
  // Index of the slot being recorded into: an existing shortcut, or one past
  // the end for a new one. Null when not recording.
  const [recordingIndex, setRecordingIndex] = useState<number | null>(null);
  const [currentKeys, setCurrentKeys] = useState<string>("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  // Use a ref to track currentKeys for the event handler (avoids stale closure)
  const currentKeysRef = useRef<string>("");
  // Track keyed vs modifier-only captures separately so a combo commits only
  // on its key's release and a modifier-only shortcut only once every
  // modifier is released. Committing on the *first* release (the old
  // behavior) silently saved just the modifier whenever the key event never
  // arrived — e.g. while macOS Secure Input is active (issue #1578).
  const keyedShortcutRef = useRef<string>("");
  const modifierOnlyShortcutRef = useRef<string>("");
  const osType = useOsType();

  const bindings = getSetting("bindings") || {};
  const binding = bindings[shortcutId];

  const shortcuts: string[] = binding
    ? [binding.current_binding, ...(binding.extra_bindings ?? [])].filter(
        (shortcut) => shortcut.trim().length > 0,
      )
    : [];
  // The commit handler runs from an event callback, so it reads the list
  // through a ref rather than a closed-over copy.
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const stopBackendRecording = useCallback(async () => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    await commands.stopHandyKeysRecording().catch(console.error);
    // The binding was taken off the hook while recording so the old keys
    // wouldn't fire the action; put it back.
    await commands.resumeAllBindings().catch(console.error);
  }, [shortcutId]);

  // Handle cancellation
  const cancelRecording = useCallback(async () => {
    if (recordingIndex === null) return;
    await stopBackendRecording();
    setRecordingIndex(null);
    setCurrentKeys("");
    currentKeysRef.current = "";
    keyedShortcutRef.current = "";
    modifierOnlyShortcutRef.current = "";
  }, [recordingIndex, stopBackendRecording]);

  // Set up event listener for handy-keys events
  useEffect(() => {
    if (recordingIndex === null) return;

    let cleanup = false;
    const targetIndex = recordingIndex;

    const setupListener = async () => {
      // Listen for key events from backend
      const commitAndStop = async (keysToCommit: string) => {
        const next = [...shortcutsRef.current];
        next[targetIndex] = keysToCommit;

        await stopBackendRecording();
        setRecordingIndex(null);
        setCurrentKeys("");
        currentKeysRef.current = "";
        keyedShortcutRef.current = "";
        modifierOnlyShortcutRef.current = "";

        try {
          await setBindingShortcuts(shortcutId, next);
        } catch (error) {
          console.error("Failed to change binding:", error);
          toast.error(
            t("settings.general.shortcut.errors.set", {
              error: String(error),
            }),
          );
        }
      };

      const unlisten = await listen<HandyKeysEvent>(
        "handy-keys-event",
        async (event) => {
          if (cleanup) return;

          const { hotkey_string, is_key_down, key, modifiers } = event.payload;

          if (is_key_down && hotkey_string) {
            // Update both state (for display) and refs (for release handler)
            if (key) {
              keyedShortcutRef.current = hotkey_string;
            } else {
              modifierOnlyShortcutRef.current = hotkey_string;
            }
            currentKeysRef.current = hotkey_string;
            setCurrentKeys(hotkey_string);
          } else if (!is_key_down && key) {
            // The main key was released — commit the keyed combo. The release
            // event's hotkey_string still contains the key, so it works even
            // if the key-down was somehow missed. Never fall back to a
            // modifier-only capture here: that's how bindings used to get
            // silently overwritten with just the modifier (issue #1578).
            const keysToCommit = keyedShortcutRef.current || hotkey_string;
            if (keysToCommit) {
              await commitAndStop(keysToCommit);
            }
          } else if (
            !is_key_down &&
            !key &&
            modifiers.length === 0 &&
            !keyedShortcutRef.current &&
            modifierOnlyShortcutRef.current
          ) {
            // Every modifier released without a main key ever going down —
            // commit as a modifier-only shortcut
            await commitAndStop(modifierOnlyShortcutRef.current);
          }
        },
      );

      unlistenRef.current = unlisten;
    };

    setupListener();

    return () => {
      cleanup = true;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      // Stop backend recording on unmount to prevent orphaned recording loops,
      // and put the suspended bindings back — otherwise navigating away
      // mid-capture leaves every shortcut unregistered.
      commands.stopHandyKeysRecording().catch(console.error);
      commands.resumeAllBindings().catch(console.error);
    };
  }, [
    recordingIndex,
    shortcutId,
    setBindingShortcuts,
    stopBackendRecording,
    t,
  ]);

  // Handle click outside
  useEffect(() => {
    if (recordingIndex === null) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        cancelRecording();
      }
    };

    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, [recordingIndex, cancelRecording]);

  // Start recording into a slot: an existing shortcut, or a new one at the end
  const startRecording = async (index: number) => {
    if (recordingIndex !== null) return;

    // The backend refuses to record while macOS Secure Input is active (the
    // recorder's listener would receive no key events and capture just the
    // modifier) — it also flips the warning banner on, so the toast points at
    // a visible explanation.
    try {
      // Silence the current shortcut first — otherwise pressing it to record a
      // replacement would fire the action instead of being captured.
      await commands.suspendAllBindings().catch(console.error);
      const result = await commands.startHandyKeysRecording(shortcutId);
      if (result.status === "error") {
        await commands.resumeAllBindings().catch(console.error);
        if (String(result.error).includes("secure-input-active")) {
          toast.error(t("secureInput.recorderBlocked"), {
            action: {
              label: t("secureInput.learnMore"),
              onClick: () => openUrl(SECURE_INPUT_HELP_URL),
            },
          });
        } else {
          toast.error(
            t("settings.general.shortcut.errors.set", {
              error: String(result.error),
            }),
          );
        }
        return;
      }
      setRecordingIndex(index);
      setCurrentKeys("");
      currentKeysRef.current = "";
      keyedShortcutRef.current = "";
      modifierOnlyShortcutRef.current = "";
    } catch (error) {
      console.error("Failed to start recording:", error);
      await commands.resumeAllBindings().catch(console.error);
      toast.error(
        t("settings.general.shortcut.errors.set", { error: String(error) }),
      );
    }
  };

  const removeShortcut = async (index: number) => {
    try {
      await setBindingShortcuts(
        shortcutId,
        shortcuts.filter((_, i) => i !== index),
      );
    } catch (error) {
      console.error("Failed to remove shortcut:", error);
      toast.error(
        t("settings.general.shortcut.errors.set", { error: String(error) }),
      );
    }
  };

  // Format the current shortcut keys being recorded
  const formatCurrentKeys = (): string => {
    if (!currentKeys) return t("settings.general.shortcut.pressKeys");
    return formatKeyCombination(currentKeys, osType);
  };

  // The settings modal supplies the title and the value line itself, so the
  // recorder renders as the row's control: every combination bound to this
  // action as an orange keycap, plus add and reset. Same handlers as below.
  if (chrome === "none") {
    if (isLoading || !binding) {
      return (
        <span
          style={{
            fontFamily: "var(--fs-font-sans)",
            fontSize: "var(--fs-text-body)",
            color: "var(--fs-ink-muted)",
          }}
        >
          {t(
            isLoading
              ? "settings.general.shortcut.loading"
              : "settings.general.shortcut.none",
          )}
        </span>
      );
    }

    const recordingPill = (
      <span
        className="inline-flex items-center whitespace-nowrap"
        style={{
          height: "24px",
          paddingInline: "8px",
          borderRadius: "var(--fs-radius-item)",
          background: "var(--fs-quiet)",
          fontFamily: "var(--fs-font-sans)",
          fontSize: "var(--fs-text-body)",
          fontWeight: 600,
          color: "var(--fs-ink)",
        }}
      >
        {formatCurrentKeys()}
      </span>
    );

    return (
      <div ref={containerRef} className="flex items-center gap-[4px]">
        <div className="flex flex-wrap items-center justify-end gap-[4px]">
          {shortcuts.length === 0 && recordingIndex === null && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => startRecording(0)}
              className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                fontFamily: "var(--fs-font-sans)",
                fontSize: "var(--fs-text-body)",
                color: "var(--fs-ink-muted)",
              }}
            >
              {t("settings.general.shortcut.addFirst")}
            </button>
          )}
          {shortcuts.map((shortcut, index) => (
            <span key={`${shortcut}-${index}`} className="group inline-flex">
              <button
                type="button"
                disabled={disabled}
                onClick={() => startRecording(index)}
                aria-label={t("settings.general.shortcut.title")}
                className="flex cursor-pointer items-center disabled:cursor-not-allowed disabled:opacity-50"
                style={{ height: "var(--fs-control-h)", paddingInline: "4px" }}
              >
                {recordingIndex === index ? (
                  recordingPill
                ) : (
                  <KeycapPill shortcut={shortcut} size="sm" />
                )}
              </button>
              {shortcuts.length > 1 && (
                <IconAction
                  onClick={() => void removeShortcut(index)}
                  label={t("settings.general.shortcut.remove")}
                  disabled={disabled || recordingIndex !== null}
                >
                  <X size={12} aria-hidden />
                </IconAction>
              )}
            </span>
          ))}
          {recordingIndex === shortcuts.length && shortcuts.length > 0 && (
            <span className="flex items-center px-[4px]">{recordingPill}</span>
          )}
        </div>
        {shortcuts.length > 0 && (
          <IconAction
            onClick={() => void startRecording(shortcuts.length)}
            label={t("settings.general.shortcut.add")}
            disabled={disabled || recordingIndex !== null}
          >
            <Plus size={14} aria-hidden />
          </IconAction>
        )}
        <IconAction
          onClick={() => void resetBinding(shortcutId)}
          label={t("settings.modal.shortcuts.reset")}
          disabled={disabled || isUpdating(`binding_${shortcutId}`)}
        >
          <RotateCcw size={14} aria-hidden />
        </IconAction>
      </div>
    );
  }

  // If still loading, show loading state
  if (isLoading) {
    return (
      <SettingContainer
        title={t("settings.general.shortcut.title")}
        description={t("settings.general.shortcut.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <div className="text-sm text-mid-gray">
          {t("settings.general.shortcut.loading")}
        </div>
      </SettingContainer>
    );
  }

  // If no bindings are loaded, show empty state
  if (Object.keys(bindings).length === 0) {
    return (
      <SettingContainer
        title={t("settings.general.shortcut.title")}
        description={t("settings.general.shortcut.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <div className="text-sm text-mid-gray">
          {t("settings.general.shortcut.none")}
        </div>
      </SettingContainer>
    );
  }

  if (!binding) {
    return (
      <SettingContainer
        title={t("settings.general.shortcut.title")}
        description={t("settings.general.shortcut.notFound")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <div className="text-sm text-mid-gray">
          {t("settings.general.shortcut.none")}
        </div>
      </SettingContainer>
    );
  }

  // Get translated name and description for the binding
  const translatedName = t(
    `settings.general.shortcut.bindings.${shortcutId}.name`,
    binding.name,
  );
  const translatedDescription = t(
    `settings.general.shortcut.bindings.${shortcutId}.description`,
    binding.description,
  );

  const isUnbound = shortcuts.length === 0 && recordingIndex === null;
  const isRecordingNewSlot = recordingIndex === shortcuts.length;

  return (
    <SettingContainer
      title={translatedName}
      description={translatedDescription}
      descriptionMode={descriptionMode}
      grouped={grouped}
      disabled={disabled}
      layout="horizontal"
    >
      <div ref={containerRef} className="flex items-center gap-1">
        <div className="flex flex-wrap items-center justify-end gap-1">
          {isUnbound && (
            <div
              className="px-2 py-1 text-sm text-mid-gray border border-dashed border-mid-gray/80 hover:bg-logo-primary/10 hover:border-logo-primary rounded-md cursor-pointer"
              onClick={() => startRecording(0)}
            >
              {t("settings.general.shortcut.addFirst")}
            </div>
          )}

          {shortcuts.map((shortcut, index) =>
            recordingIndex === index ? (
              <div
                key={`recording-${index}`}
                className="px-2 py-1 text-sm font-semibold border border-logo-primary bg-logo-primary/30 rounded-md"
              >
                {formatCurrentKeys()}
              </div>
            ) : (
              <div
                key={`${shortcut}-${index}`}
                className="group flex items-center gap-1 pl-2 pr-1 py-1 text-sm font-semibold bg-mid-gray/10 border border-mid-gray/80 hover:bg-logo-primary/10 hover:border-logo-primary rounded-md cursor-pointer"
                onClick={() => startRecording(index)}
              >
                {formatKeyCombination(shortcut, osType)}
                <button
                  type="button"
                  aria-label={t("settings.general.shortcut.remove")}
                  title={t("settings.general.shortcut.remove")}
                  className="opacity-0 group-hover:opacity-100 text-mid-gray hover:text-logo-primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeShortcut(index);
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            ),
          )}

          {/* A brand new slot being recorded at the end of the list */}
          {isRecordingNewSlot && shortcuts.length > 0 && (
            <div className="px-2 py-1 text-sm font-semibold border border-logo-primary bg-logo-primary/30 rounded-md">
              {formatCurrentKeys()}
            </div>
          )}
        </div>

        {!isUnbound && (
          <button
            type="button"
            aria-label={t("settings.general.shortcut.add")}
            title={t("settings.general.shortcut.add")}
            className="p-1.5 bg-mid-gray/10 border border-mid-gray/80 hover:bg-logo-primary/10 hover:border-logo-primary rounded-md text-mid-gray disabled:opacity-40"
            disabled={recordingIndex !== null}
            onClick={() => startRecording(shortcuts.length)}
          >
            <Plus size={14} />
          </button>
        )}

        <ResetButton
          onClick={() => resetBinding(shortcutId)}
          disabled={isUpdating(`binding_${shortcutId}`)}
        />
      </div>
    </SettingContainer>
  );
};
