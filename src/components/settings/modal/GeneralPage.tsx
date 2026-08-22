import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type } from "@tauri-apps/plugin-os";
import { commands, type ModelInfo, type Theme } from "@/bindings";
import { SettingRow } from "@/components/ui";
import { useSettings } from "@/hooks/useSettings";
import {
  getSupportedLanguage,
  SUPPORTED_LANGUAGES,
  type SupportedLanguageCode,
} from "@/i18n";
import {
  getLanguageLabel,
  SELECTABLE_LANGUAGES,
  supportsLanguageCode,
} from "@/lib/constants/languages";
import { applyTheme, THEME_OPTIONS } from "@/lib/utils/theme";
import { useModelStore } from "@/stores/modelStore";
import { effectiveLanguage } from "../LanguageSelector";
import { FieldSelect } from "./controls";
import { GroupCard, ShortcutRow, ToggleRow } from "./rows";

/** The device list stores "default" and shows it as "Default". */
const DEFAULT_DEVICE = "Default";

/**
 * Shortcuts, how recording is triggered, which microphone it listens to, and
 * the two languages — the reference's General page, with our bindings in place
 * of its single `Shortcuts` row.
 */
export const GeneralPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const {
    settings,
    getSetting,
    updateSetting,
    isUpdating,
    isLoading,
    audioDevices,
    refreshAudioDevices,
  } = useSettings();
  const { currentModel, models } = useModelStore();
  const [isLaptop, setIsLaptop] = useState(false);
  const [channelCount, setChannelCount] = useState(1);

  const pushToTalk = getSetting("push_to_talk") ?? false;
  const isLinux = type() === "linux";

  const selectedMicrophone =
    getSetting("selected_microphone") === "default"
      ? DEFAULT_DEVICE
      : getSetting("selected_microphone") || DEFAULT_DEVICE;
  const clamshellMicrophone =
    getSetting("clamshell_microphone") === "default"
      ? DEFAULT_DEVICE
      : getSetting("clamshell_microphone") || DEFAULT_DEVICE;
  const selectedChannel = getSetting("selected_channel");

  useEffect(() => {
    commands
      .isLaptop()
      .then((result) => setIsLaptop(result.status === "ok" && result.data))
      .catch(() => setIsLaptop(false));
  }, []);

  // Channel count for the selected device; the row is only meaningful on a
  // multi-channel interface.
  useEffect(() => {
    let cancelled = false;
    setChannelCount(1);
    const device =
      selectedMicrophone === DEFAULT_DEVICE ? "default" : selectedMicrophone;
    commands
      .getMicrophoneChannels(device)
      .then((result) => {
        if (!cancelled && result.status === "ok") setChannelCount(result.data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedMicrophone]);

  const deviceOptions = audioDevices.map((device) => ({
    value: device.name,
    label: device.name,
  }));

  const channelOptions = [
    { value: "average", label: t("settings.sound.channel.average") },
    ...Array.from({ length: channelCount }, (_, index) => ({
      value: index.toString(),
      label: t("settings.sound.channel.channel", { n: index + 1 }),
    })),
  ];
  const currentChannel =
    selectedChannel == null || selectedChannel >= channelCount
      ? "average"
      : selectedChannel.toString();

  // Dictation language: the persisted value is an intent, and what the engine
  // actually uses depends on the loaded model — so the row shows the resolved
  // value and offers only what this model can do.
  const currentModelInfo = models.find((m: ModelInfo) => m.id === currentModel);
  const supportedLanguages = currentModelInfo?.supported_languages ?? [];
  const supportsDetection =
    currentModelInfo?.supports_language_detection ?? true;
  const dictationLanguage = effectiveLanguage(
    getSetting("selected_language") || "auto",
    supportedLanguages,
    supportsDetection,
  );
  const dictationOptions = useMemo(() => {
    const available =
      supportedLanguages.length === 0
        ? SELECTABLE_LANGUAGES
        : SELECTABLE_LANGUAGES.filter((language) =>
            language.value === "auto"
              ? supportsDetection
              : supportsLanguageCode(supportedLanguages, language.value),
          );
    return available.map((language) => ({
      value: language.value,
      label: language.label,
    }));
  }, [supportedLanguages, supportsDetection]);

  const appLanguage = (getSupportedLanguage(settings?.app_language) ||
    i18n.language) as SupportedLanguageCode;
  const theme: Theme = settings?.theme ?? "system";

  return (
    <>
      <GroupCard title={t("settings.general.shortcuts.title")}>
        <ShortcutRow
          shortcutId="transcribe"
          hintKey="settings.modal.shortcuts.hints.transcribe"
        />
        <ShortcutRow
          shortcutId="transcribe_hands_free"
          hintKey="settings.modal.shortcuts.hints.transcribe_hands_free"
        />
        <ShortcutRow
          shortcutId="submit_transcription"
          hintKey="settings.modal.shortcuts.hints.submit_transcription"
        />
        <ShortcutRow
          shortcutId="paste_last_transcript"
          hintKey="settings.modal.shortcuts.hints.paste_last_transcript"
        />
        {/* Push-to-talk cancels on release, and Linux re-registration is
            unstable — the same two conditions the old page used. */}
        {!isLinux && !pushToTalk && (
          <ShortcutRow
            shortcutId="cancel"
            hintKey="settings.modal.shortcuts.hints.cancel"
          />
        )}
      </GroupCard>

      <GroupCard title={t("settings.modal.groups.dictation")}>
        <ToggleRow
          settingKey="push_to_talk"
          title={t("settings.general.pushToTalk.label")}
          subtitle={t("settings.general.pushToTalk.description")}
        />
        {pushToTalk && (
          <ToggleRow
            settingKey="ptt_double_tap_lock"
            title={t("settings.general.pttDoubleTapLock.label")}
            subtitle={t("settings.modal.hints.pttDoubleTapLock")}
          />
        )}
        <SettingRow
          title={t("settings.modal.rows.dictationLanguage")}
          subtitle={
            getLanguageLabel(dictationLanguage) ||
            t("settings.general.language.auto")
          }
        >
          <FieldSelect
            options={dictationOptions}
            value={dictationLanguage}
            searchable
            onSelect={(value) => void updateSetting("selected_language", value)}
            disabled={isUpdating("selected_language")}
          />
        </SettingRow>
      </GroupCard>

      <GroupCard title={t("settings.sound.microphone.title")}>
        <SettingRow
          title={t("settings.sound.microphone.title")}
          subtitle={selectedMicrophone}
        >
          <FieldSelect
            wide
            options={deviceOptions}
            value={selectedMicrophone}
            placeholder={t("settings.sound.microphone.loading")}
            onOpen={refreshAudioDevices}
            onSelect={(value) =>
              void updateSetting("selected_microphone", value)
            }
            disabled={
              isUpdating("selected_microphone") ||
              isLoading ||
              audioDevices.length === 0
            }
          />
        </SettingRow>
        {channelCount > 1 && (
          <SettingRow
            title={t("settings.sound.channel.title")}
            subtitle={
              channelOptions.find((option) => option.value === currentChannel)
                ?.label ?? ""
            }
          >
            <FieldSelect
              options={channelOptions}
              value={currentChannel}
              onSelect={(value) =>
                void updateSetting(
                  "selected_channel",
                  value === "average" ? null : parseInt(value, 10),
                )
              }
              disabled={isUpdating("selected_channel") || isLoading}
            />
          </SettingRow>
        )}
        {isLaptop && (
          <SettingRow
            title={t("settings.debug.clamshellMicrophone.title")}
            subtitle={clamshellMicrophone}
          >
            <FieldSelect
              wide
              options={deviceOptions}
              value={clamshellMicrophone}
              placeholder={t("settings.sound.microphone.loading")}
              onOpen={refreshAudioDevices}
              onSelect={(value) =>
                void updateSetting("clamshell_microphone", value)
              }
              disabled={
                isUpdating("clamshell_microphone") ||
                isLoading ||
                audioDevices.length === 0
              }
            />
          </SettingRow>
        )}
      </GroupCard>

      <GroupCard title={t("settings.modal.groups.interface")}>
        <SettingRow
          title={t("appLanguage.title")}
          subtitle={t("settings.modal.hints.appLanguage")}
        >
          <FieldSelect
            options={SUPPORTED_LANGUAGES.map((language) => ({
              value: language.code,
              label: `${language.nativeName} (${language.name})`,
            }))}
            value={appLanguage}
            onSelect={(value) => {
              void i18n.changeLanguage(value);
              void updateSetting("app_language", value);
            }}
          />
        </SettingRow>
        <SettingRow
          title={t("theme.title")}
          subtitle={t(`theme.options.${theme}`)}
        >
          <FieldSelect
            options={THEME_OPTIONS.map((option) => ({
              value: option,
              label: t(`theme.options.${option}`),
            }))}
            value={theme}
            onSelect={(value) => {
              applyTheme(value as Theme);
              void updateSetting("theme", value as Theme);
            }}
          />
        </SettingRow>
      </GroupCard>
    </>
  );
};
