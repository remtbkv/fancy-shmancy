import React from "react";
import { useTranslation } from "react-i18next";
import { type } from "@tauri-apps/plugin-os";
import { MicrophoneSelector } from "../MicrophoneSelector";
import { ShortcutInput } from "../ShortcutInput";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { OutputDeviceSelector } from "../OutputDeviceSelector";
import { PushToTalk } from "../PushToTalk";
import { PttDoubleTapLock } from "../PttDoubleTapLock";
import { CancelOnEditingKeys } from "../CancelOnEditingKeys";
import { EditingCancelGrace } from "../EditingCancelGrace";
import { PasteLastTranscriptWindow } from "../PasteLastTranscriptWindow";
import { AudioFeedback } from "../AudioFeedback";
import { useSettings } from "../../../hooks/useSettings";
import { VolumeSlider } from "../VolumeSlider";
import { MuteWhileRecording } from "../MuteWhileRecording";
import { PausePlaybackWhileRecording } from "../PausePlaybackWhileRecording";
import { ModelSettingsCard } from "./ModelSettingsCard";

export const GeneralSettings: React.FC = () => {
  const { t } = useTranslation();
  const { audioFeedbackEnabled, getSetting } = useSettings();
  const pushToTalk = getSetting("push_to_talk");
  const cancelOnEditingKeys = getSetting("cancel_on_editing_keys") ?? true;
  const isLinux = type() === "linux";
  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.general.shortcuts.title")}>
        <ShortcutInput shortcutId="transcribe" grouped={true} />
        <ShortcutInput shortcutId="transcribe_hands_free" grouped={true} />
        <ShortcutInput shortcutId="stop_recording" grouped={true} />
        <ShortcutInput shortcutId="submit_transcription" grouped={true} />
        <ShortcutInput shortcutId="paste_last_transcript" grouped={true} />
        {/* Cancel shortcut is hidden with push-to-talk (release key cancels) and on Linux (dynamic shortcut instability) */}
        {!isLinux && !pushToTalk && (
          <ShortcutInput shortcutId="cancel" grouped={true} />
        )}
      </SettingsGroup>
      <SettingsGroup title={t("settings.general.title")}>
        <PushToTalk descriptionMode="tooltip" grouped={true} />
        {pushToTalk && (
          <PttDoubleTapLock descriptionMode="tooltip" grouped={true} />
        )}
        {/* Only push-to-talk holds a key long enough for an editing chord to be mistaken for dictation */}
        {pushToTalk && (
          <CancelOnEditingKeys descriptionMode="tooltip" grouped={true} />
        )}
        {pushToTalk && cancelOnEditingKeys && (
          <EditingCancelGrace descriptionMode="tooltip" grouped={true} />
        )}
      </SettingsGroup>
      <SettingsGroup title={t("settings.general.pasteLastTranscript.title")}>
        <PasteLastTranscriptWindow descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
      <ModelSettingsCard />
      <SettingsGroup title={t("settings.sound.title")}>
        <MicrophoneSelector descriptionMode="tooltip" grouped={true} />
        <MuteWhileRecording descriptionMode="tooltip" grouped={true} />
        <PausePlaybackWhileRecording descriptionMode="tooltip" grouped={true} />
        <AudioFeedback descriptionMode="tooltip" grouped={true} />
        <OutputDeviceSelector
          descriptionMode="tooltip"
          grouped={true}
          disabled={!audioFeedbackEnabled}
        />
        <VolumeSlider disabled={!audioFeedbackEnabled} />
      </SettingsGroup>
    </div>
  );
};
