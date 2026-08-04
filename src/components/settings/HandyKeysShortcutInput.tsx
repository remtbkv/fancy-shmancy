import React, { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Plus, X } from "lucide-react";
import { formatKeyCombination } from "../../lib/utils/keyboard";
import { ResetButton } from "../ui/ResetButton";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import { useOsType } from "../../hooks/useOsType";
import { commands } from "@/bindings";
import { toast } from "sonner";

interface HandyKeysShortcutInputProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  shortcutId: string;
  disabled?: boolean;
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
    await commands.resumeBinding(shortcutId).catch(console.error);
  }, [shortcutId]);

  // Handle cancellation
  const cancelRecording = useCallback(async () => {
    if (recordingIndex === null) return;
    await stopBackendRecording();
    setRecordingIndex(null);
    setCurrentKeys("");
    currentKeysRef.current = "";
  }, [recordingIndex, stopBackendRecording]);

  // Set up event listener for handy-keys events
  useEffect(() => {
    if (recordingIndex === null) return;

    let cleanup = false;
    const targetIndex = recordingIndex;

    const setupListener = async () => {
      // Listen for key events from backend
      const unlisten = await listen<HandyKeysEvent>(
        "handy-keys-event",
        async (event) => {
          if (cleanup) return;

          const { hotkey_string, is_key_down } = event.payload;

          if (is_key_down && hotkey_string) {
            // Update both state (for display) and ref (for release handler)
            currentKeysRef.current = hotkey_string;
            setCurrentKeys(hotkey_string);
          } else if (!is_key_down && currentKeysRef.current) {
            // Key released - commit the shortcut using the ref value
            const recorded = currentKeysRef.current;
            const next = [...shortcutsRef.current];
            next[targetIndex] = recorded;

            await stopBackendRecording();
            setRecordingIndex(null);
            setCurrentKeys("");
            currentKeysRef.current = "";

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
      // Stop backend recording on unmount to prevent orphaned recording loops
      commands.stopHandyKeysRecording().catch(console.error);
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

    try {
      // Silence the current shortcut first — otherwise pressing it to record a
      // replacement would fire the action instead of being captured.
      await commands.suspendBinding(shortcutId).catch(console.error);
      await commands.startHandyKeysRecording(shortcutId);
      setRecordingIndex(index);
      setCurrentKeys("");
      currentKeysRef.current = "";
    } catch (error) {
      console.error("Failed to start recording:", error);
      await commands.resumeBinding(shortcutId).catch(console.error);
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
