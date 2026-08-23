import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  commands,
  type ModelUnloadTimeout,
  type OrtAcceleratorSetting,
  type TranscribeAcceleratorSetting,
} from "@/bindings";
import { SettingRow } from "@/components/ui";
import { useSettings } from "@/hooks/useSettings";
import { FieldSelect, type FieldOption } from "./controls";
import { GroupCard, ToggleRow } from "./rows";

const ORT_LABELS: Record<OrtAcceleratorSetting, string> = {
  auto: "Auto",
  cpu: "CPU",
  cuda: "CUDA",
  directml: "DirectML",
  rocm: "ROCm",
};

/**
 * The unload options, paired with the translation key they had before the
 * modal existed.
 *
 * The values are what serde reads and writes — `min15`, `hour1`, `hours4` — and
 * every cast below is deliberate. The generated `ModelUnloadTimeout` union
 * spells them `min_15`, `hour_1`, `hours_4`, because specta puts a boundary
 * before a digit where serde's `rename_all = "snake_case"` does not. Sending
 * the generated spelling means Rust cannot parse what the dropdown wrote, and
 * comparing against it means a stored `hours4` matches nothing and the row
 * renders blank. `settings.rs::unload_timeout_serde_names_are_what_the_dropdown_sends`
 * pins the real contract.
 */
const UNLOAD_OPTIONS: { value: ModelUnloadTimeout; key: string }[] = [
  { value: "never", key: "never" },
  { value: "immediately", key: "immediately" },
  { value: "min2" as ModelUnloadTimeout, key: "min2" },
  { value: "min5" as ModelUnloadTimeout, key: "min5" },
  { value: "min10" as ModelUnloadTimeout, key: "min10" },
  { value: "min15" as ModelUnloadTimeout, key: "min15" },
  { value: "hour1" as ModelUnloadTimeout, key: "hour1" },
  { value: "hours4" as ModelUnloadTimeout, key: "hours4" },
];
const UNLOAD_DEBUG_OPTION = {
  value: "sec15" as ModelUnloadTimeout,
  key: "sec15",
};

/**
 * How the engine runs — acceleration, when the model is unloaded, and what the
 * microphone does between takes.
 *
 * One group inside Advanced rather than a page of its own: the model catalogue
 * is a sidebar page in the main window, and a "Models" entry in the settings
 * sidebar too made the same word mean two different places. These four rows
 * are the only model settings that are not about *which* model.
 */
export const ModelsPerformance: React.FC = () => {
  const { t } = useTranslation();
  const { settings, getSetting, updateSetting, isUpdating } = useSettings();
  const [transcribeOptions, setTranscribeOptions] = useState<FieldOption[]>([]);
  const [ortOptions, setOrtOptions] = useState<FieldOption[]>([]);

  // Same shape as the old selector: the transcribe.cpp dropdown encodes
  // accelerator + device in one value ("auto" | "cpu" | "gpu:<id>").
  useEffect(() => {
    commands
      .getAvailableAccelerators()
      .then((available) => {
        const options: FieldOption[] = [];
        if (available.transcribe.includes("auto")) {
          options.push({
            value: "auto",
            label: t("settings.advanced.acceleration.gpuDevice.auto"),
          });
        }
        if (available.transcribe.includes("gpu")) {
          for (const device of available.gpu_devices) {
            const vram =
              device.total_vram_mb >= 1024
                ? `${(device.total_vram_mb / 1024).toFixed(1)} GB`
                : `${device.total_vram_mb} MB`;
            options.push({
              value: `gpu:${device.id}`,
              label: `${device.name} (${vram})`,
            });
          }
        }
        if (available.transcribe.includes("cpu")) {
          options.push({ value: "cpu", label: "CPU" });
        }
        setTranscribeOptions(options);

        const ortValues = available.ort.includes("auto")
          ? available.ort
          : ["auto", ...available.ort];
        setOrtOptions(
          ortValues.map((value) => ({
            value,
            label: ORT_LABELS[value as OrtAcceleratorSetting] ?? value,
          })),
        );
      })
      .catch(() => undefined);
  }, [t]);

  const accelerator = (getSetting("transcribe_accelerator") ??
    "auto") as TranscribeAcceleratorSetting;
  const gpuDevice = getSetting("transcribe_gpu_device") ?? null;
  const encoded =
    accelerator === "cpu"
      ? "cpu"
      : accelerator === "gpu" && gpuDevice !== null
        ? `gpu:${gpuDevice}`
        : "auto";
  const transcribeValue = transcribeOptions.some(
    (option) => option.value === encoded,
  )
    ? encoded
    : (transcribeOptions[0]?.value ?? null);
  const ortValue = (getSetting("ort_accelerator") ??
    "auto") as OrtAcceleratorSetting;

  const unloadOptions = (
    settings?.debug_mode === true
      ? [...UNLOAD_OPTIONS, UNLOAD_DEBUG_OPTION]
      : UNLOAD_OPTIONS
  ).map((option) => ({
    value: option.value,
    label: t(`settings.advanced.modelUnload.options.${option.key}`),
  }));
  const unloadValue = (getSetting("model_unload_timeout") ??
    "never") as ModelUnloadTimeout;

  const selectTranscribe = async (value: string) => {
    // Save the device first, or `gpu + null` normalizes straight back to Auto.
    const nextDevice = value.startsWith("gpu:") ? value.slice(4) : null;
    const nextAccelerator: TranscribeAcceleratorSetting =
      value === "cpu" ? "cpu" : value.startsWith("gpu:") ? "gpu" : "auto";
    await updateSetting("transcribe_gpu_device", nextDevice);
    await updateSetting("transcribe_accelerator", nextAccelerator);
  };

  const selectUnload = async (value: string) => {
    const next = value as ModelUnloadTimeout;
    try {
      await commands.setModelUnloadTimeout(next);
      await updateSetting("model_unload_timeout", next);
    } catch (error) {
      console.error("Failed to update model unload timeout:", error);
    }
  };

  return (
    <GroupCard title={t("settings.modal.groups.modelsPerformance")}>
      <SettingRow
        title={t("settings.advanced.acceleration.transcribe.title")}
        subtitle={
          transcribeOptions.find((option) => option.value === transcribeValue)
            ?.label ?? t("common.loading")
        }
      >
        <FieldSelect
          wide
          options={transcribeOptions}
          value={transcribeValue}
          placeholder={t("common.loading")}
          onSelect={(value) => void selectTranscribe(value)}
          disabled={
            isUpdating("transcribe_accelerator") ||
            isUpdating("transcribe_gpu_device")
          }
        />
      </SettingRow>
      {ortOptions.length > 2 && (
        <SettingRow
          title={t("settings.advanced.acceleration.ort.title")}
          subtitle={ORT_LABELS[ortValue] ?? ortValue}
        >
          <FieldSelect
            options={ortOptions}
            value={ortValue}
            onSelect={(value) =>
              void updateSetting(
                "ort_accelerator",
                value as OrtAcceleratorSetting,
              )
            }
            disabled={isUpdating("ort_accelerator")}
          />
        </SettingRow>
      )}
      <SettingRow
        title={t("settings.advanced.modelUnload.title")}
        subtitle={
          unloadOptions.find((option) => option.value === unloadValue)?.label ??
          ""
        }
      >
        <FieldSelect
          options={unloadOptions}
          value={unloadValue}
          onSelect={(value) => void selectUnload(value)}
        />
      </SettingRow>
      <ToggleRow
        settingKey="vad_enabled"
        title={t("settings.advanced.voiceActivityDetection.title")}
        subtitle={t("settings.modal.hints.vad")}
        fallback
      />
      <ToggleRow
        settingKey="always_on_microphone"
        title={t("settings.debug.alwaysOnMicrophone.label")}
        subtitle={t("settings.debug.alwaysOnMicrophone.description")}
      />
    </GroupCard>
  );
};
