import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import {
  commands,
  type AutoSubmitKey,
  type ClipboardHandling,
  type ModelInfo,
  type PasteMethod,
  type TypingTool,
} from "@/bindings";
import { PillButton, SettingRow } from "@/components/ui";
import { useOsType } from "@/hooks/useOsType";
import { useSettings } from "@/hooks/useSettings";
import { useModelStore } from "@/stores/modelStore";
import { PostProcessingSettings } from "../post-processing/PostProcessingSettings";
import { FieldSelect, NumberField, TagList, TextField } from "./controls";
import { ModelsPerformance } from "./ModelsPerformance";
import { GroupCard, ToggleRow } from "./rows";

const MIN_GRACE_MS = 1;
const MAX_GRACE_MS = 2000;

const KEYBOARD_IMPLEMENTATIONS = [
  { value: "tauri", label: "Tauri Global Shortcut" },
  { value: "handy_keys", label: "Handy Keys" },
];

const TYPING_TOOL_LABELS: Record<string, string> = {
  wtype: "wtype",
  kwtype: "kwtype",
  dotool: "dotool",
  ydotool: "ydotool",
  xdotool: "xdotool",
};

/**
 * How the engine runs, everything about what happens to the text after it is
 * recognised, and the experimental group. The reference has no equivalent
 * page — its own advanced settings live behind features we do not have — so
 * this follows its System page's grammar: sentence-case headings over cream
 * cards of rows.
 */
export const AdvancedPage: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating, refreshSettings } =
    useSettings();
  const osType = useOsType();
  const { currentModel, models } = useModelStore();
  const [configuringPostProcess, setConfiguringPostProcess] = useState(false);
  const [newApp, setNewApp] = useState("");
  const [lastTarget, setLastTarget] = useState<string | null>(null);
  const [typingTools, setTypingTools] = useState<string[] | null>(null);

  const pasteMethod = (getSetting("paste_method") || "ctrl_v") as PasteMethod;
  const externalScriptPath = getSetting("external_script_path") || "";
  const clipboardHandling = (getSetting("clipboard_handling") ||
    "dont_modify") as ClipboardHandling;
  const autoSubmit = getSetting("auto_submit") ?? false;
  const autoSubmitKey = (getSetting("auto_submit_key") ||
    "enter") as AutoSubmitKey;
  const typingTool = (getSetting("typing_tool") || "auto") as TypingTool;
  const typedOutApps = getSetting("typed_out_apps") || [];
  const pushToTalk = getSetting("push_to_talk") ?? false;
  const cancelOnEditingKeys = getSetting("cancel_on_editing_keys") ?? true;
  const graceMs = getSetting("editing_cancel_grace_ms") ?? 250;
  const experimental = getSetting("experimental_enabled") ?? false;
  const keyboardImplementation =
    getSetting("keyboard_implementation") ?? "tauri";

  const supportsTranslation =
    models.find((model: ModelInfo) => model.id === currentModel)
      ?.supports_translation ?? false;

  // The app the last transcript landed in — nobody knows their bundle
  // identifiers by heart, so the one just used is offered for adding.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const target = await commands.getLastPasteTarget().catch(() => null);
      if (!cancelled) setLastTarget(target);
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (osType !== "linux") return;
    commands
      .getAvailableTypingTools()
      .then(setTypingTools)
      .catch(() => setTypingTools(["auto"]));
  }, [osType]);

  const pasteMethodOptions = [
    {
      value: "ctrl_v",
      label: t("settings.advanced.pasteMethod.options.clipboard", {
        modifier: osType === "macos" ? "Cmd" : "Ctrl",
      }),
    },
    {
      value: "direct",
      label: t("settings.advanced.pasteMethod.options.direct"),
    },
    { value: "none", label: t("settings.advanced.pasteMethod.options.none") },
    ...(osType === "windows" || osType === "linux"
      ? [
          {
            value: "ctrl_shift_v",
            label: t(
              "settings.advanced.pasteMethod.options.clipboardCtrlShiftV",
            ),
          },
          {
            value: "shift_insert",
            label: t(
              "settings.advanced.pasteMethod.options.clipboardShiftInsert",
            ),
          },
        ]
      : []),
    ...(osType === "linux"
      ? [
          {
            value: "external_script",
            label: t("settings.advanced.pasteMethod.options.externalScript"),
          },
        ]
      : []),
  ];

  const clipboardOptions = [
    {
      value: "dont_modify",
      label: t("settings.advanced.clipboardHandling.options.dontModify"),
    },
    {
      value: "copy_to_clipboard",
      label: t("settings.advanced.clipboardHandling.options.copyToClipboard"),
    },
  ];

  const autoSubmitOptions = [
    { value: "off", label: t("settings.advanced.autoSubmit.options.off") },
    { value: "enter", label: t("settings.advanced.autoSubmit.options.enter") },
    {
      value: "ctrl_enter",
      label: t("settings.advanced.autoSubmit.options.ctrlEnter"),
    },
    {
      value: "cmd_enter",
      label:
        osType === "macos"
          ? t("settings.advanced.autoSubmit.options.cmdEnter")
          : t("settings.advanced.autoSubmit.options.superEnter"),
    },
  ];
  const autoSubmitValue = autoSubmit ? autoSubmitKey : "off";

  const typingToolOptions = (typingTools ?? ["auto"]).map((tool) =>
    tool === "auto"
      ? { value: "auto", label: t("settings.advanced.typingTool.options.auto") }
      : { value: tool, label: TYPING_TOOL_LABELS[tool] ?? tool },
  );

  const addApp = (candidate: string) => {
    const bundleId = candidate.trim();
    if (!bundleId) return;
    if (
      typedOutApps.some((app) => app.toLowerCase() === bundleId.toLowerCase())
    ) {
      toast.error(t("settings.advanced.typedOutApps.duplicate"));
      return;
    }
    void updateSetting("typed_out_apps", [...typedOutApps, bundleId]);
    setNewApp("");
  };

  const selectAutoSubmit = async (value: string) => {
    if (value === "off") {
      await updateSetting("auto_submit", false);
      return;
    }
    await updateSetting("auto_submit_key", value as AutoSubmitKey);
    if (!autoSubmit) await updateSetting("auto_submit", true);
  };

  const selectKeyboardImplementation = async (value: string) => {
    if (value === keyboardImplementation) return;
    try {
      const result = await commands.changeKeyboardImplementationSetting(value);
      if (result.status === "error") {
        toast.error(String(result.error));
        return;
      }
      if (result.data.reset_bindings.length > 0) {
        toast.warning(t("settings.debug.keyboardImplementation.bindingsReset"));
      }
      await refreshSettings();
    } catch (error) {
      toast.error(String(error));
    }
  };

  if (configuringPostProcess) {
    return (
      <>
        <PillButton onClick={() => setConfiguringPostProcess(false)}>
          <ArrowLeft size={14} aria-hidden className="mr-[6px]" />
          {t("settings.modal.rows.back")}
        </PillButton>
        <div className="mt-[24px]">
          <PostProcessingSettings />
        </div>
      </>
    );
  }

  return (
    <>
      <ModelsPerformance />

      <GroupCard title={t("settings.advanced.groups.output")}>
        <SettingRow
          title={t("settings.advanced.pasteMethod.title")}
          subtitle={
            pasteMethodOptions.find((option) => option.value === pasteMethod)
              ?.label ?? ""
          }
        >
          <FieldSelect
            wide
            options={pasteMethodOptions}
            value={pasteMethod}
            onSelect={(value) =>
              void updateSetting("paste_method", value as PasteMethod)
            }
            disabled={isUpdating("paste_method")}
          />
        </SettingRow>
        {pasteMethod === "external_script" && (
          <SettingRow
            title={t("settings.advanced.pasteMethod.options.externalScript")}
            subtitle={
              externalScriptPath ||
              t("settings.advanced.pasteMethod.externalScriptPlaceholder")
            }
          >
            <TextField
              width="220px"
              value={externalScriptPath}
              ariaLabel={t(
                "settings.advanced.pasteMethod.options.externalScript",
              )}
              placeholder={t(
                "settings.advanced.pasteMethod.externalScriptPlaceholder",
              )}
              onChange={(value) =>
                void updateSetting("external_script_path", value)
              }
              disabled={isUpdating("external_script_path")}
            />
          </SettingRow>
        )}
        {osType === "linux" && pasteMethod === "direct" && (
          <SettingRow
            title={t("settings.advanced.typingTool.title")}
            subtitle={
              typingToolOptions.find((option) => option.value === typingTool)
                ?.label ?? ""
            }
          >
            <FieldSelect
              options={typingToolOptions}
              value={typingTool}
              onSelect={(value) =>
                void updateSetting("typing_tool", value as TypingTool)
              }
              disabled={isUpdating("typing_tool")}
            />
          </SettingRow>
        )}
        <SettingRow
          title={t("settings.advanced.clipboardHandling.title")}
          subtitle={
            clipboardOptions.find(
              (option) => option.value === clipboardHandling,
            )?.label ?? ""
          }
        >
          <FieldSelect
            wide
            options={clipboardOptions}
            value={clipboardHandling}
            onSelect={(value) =>
              void updateSetting(
                "clipboard_handling",
                value as ClipboardHandling,
              )
            }
            disabled={isUpdating("clipboard_handling")}
          />
        </SettingRow>
        <SettingRow
          title={t("settings.advanced.autoSubmit.title")}
          subtitle={
            autoSubmitOptions.find((option) => option.value === autoSubmitValue)
              ?.label ?? ""
          }
        >
          <FieldSelect
            options={autoSubmitOptions}
            value={autoSubmitValue}
            onSelect={(value) => void selectAutoSubmit(value)}
            disabled={
              isUpdating("auto_submit") || isUpdating("auto_submit_key")
            }
          />
        </SettingRow>
        <ToggleRow
          settingKey="append_trailing_space"
          title={t("settings.debug.appendTrailingSpace.label")}
        />
        <SettingRow
          title={t("settings.advanced.typedOutApps.title")}
          subtitle={t("settings.modal.hints.typedOutApps")}
        >
          <div className="flex items-center gap-[8px]">
            <TextField
              value={newApp}
              ariaLabel={t("settings.advanced.typedOutApps.title")}
              placeholder={t("settings.advanced.typedOutApps.placeholder")}
              onChange={setNewApp}
              onSubmit={() => addApp(newApp)}
              disabled={isUpdating("typed_out_apps")}
            />
            <PillButton
              onClick={() => addApp(newApp)}
              disabled={!newApp.trim() || isUpdating("typed_out_apps")}
            >
              {t("settings.advanced.typedOutApps.add")}
            </PillButton>
          </div>
        </SettingRow>
        <TagList
          items={typedOutApps}
          disabled={isUpdating("typed_out_apps")}
          removeLabel={(app) =>
            t("settings.advanced.typedOutApps.remove", { app })
          }
          onRemove={(app) =>
            void updateSetting(
              "typed_out_apps",
              typedOutApps.filter((entry) => entry !== app),
            )
          }
        />
        {lastTarget !== null &&
          !typedOutApps.some(
            (app) => app.toLowerCase() === lastTarget.toLowerCase(),
          ) && (
            <SettingRow title={t("settings.modal.rows.lastPasteTarget")}>
              <PillButton
                onClick={() => addApp(lastTarget)}
                disabled={isUpdating("typed_out_apps")}
              >
                {t("settings.advanced.typedOutApps.addLast", {
                  app: lastTarget,
                })}
              </PillButton>
            </SettingRow>
          )}
      </GroupCard>

      <GroupCard title={t("settings.advanced.groups.transcription")}>
        <ToggleRow
          settingKey="filler_word_removal_enabled"
          title={t("settings.advanced.fillerWordRemoval.title")}
          subtitle={t("settings.modal.hints.fillerWords")}
          fallback
        />
        {supportsTranslation && (
          <ToggleRow
            settingKey="translate_to_english"
            title={t("settings.advanced.translateToEnglish.label")}
            subtitle={t("settings.modal.hints.translateToEnglish")}
          />
        )}
        {/* Only push-to-talk holds a key long enough for an editing chord to
            be mistaken for dictation. */}
        {pushToTalk && (
          <ToggleRow
            settingKey="cancel_on_editing_keys"
            title={t("settings.general.cancelOnEditingKeys.label")}
            subtitle={t("settings.modal.hints.cancelOnEditingKeys")}
            fallback
          />
        )}
        {pushToTalk && cancelOnEditingKeys && (
          <SettingRow
            title={t("settings.general.editingCancelGrace.title")}
            subtitle={t("settings.modal.hints.editingCancelGrace")}
          >
            <NumberField
              value={graceMs}
              unit={t("settings.general.editingCancelGrace.ms")}
              min={MIN_GRACE_MS}
              max={MAX_GRACE_MS}
              step={50}
              disabled={isUpdating("editing_cancel_grace_ms")}
              onCommit={(next) =>
                void updateSetting("editing_cancel_grace_ms", next)
              }
            />
          </SettingRow>
        )}
      </GroupCard>

      <GroupCard title={t("settings.modal.groups.postProcessing")}>
        <SettingRow
          title={t("settings.modal.rows.postProcessing")}
          subtitle={t("settings.modal.hints.postProcessing")}
        >
          <PillButton onClick={() => setConfiguringPostProcess(true)}>
            {t("settings.modal.rows.configure")}
          </PillButton>
        </SettingRow>
      </GroupCard>

      <GroupCard title={t("settings.advanced.groups.experimental")}>
        <ToggleRow
          settingKey="experimental_enabled"
          title={t("settings.advanced.experimentalToggle.label")}
          subtitle={t("settings.modal.hints.experimental")}
        />
        {experimental && (
          <>
            <ToggleRow
              settingKey="post_process_enabled"
              title={t("settings.debug.postProcessingToggle.label")}
              subtitle={t("settings.debug.postProcessingToggle.description")}
            />
            <SettingRow
              title={t("settings.debug.keyboardImplementation.title")}
              subtitle={
                KEYBOARD_IMPLEMENTATIONS.find(
                  (option) => option.value === keyboardImplementation,
                )?.label ?? ""
              }
            >
              <FieldSelect
                wide
                options={KEYBOARD_IMPLEMENTATIONS}
                value={keyboardImplementation}
                onSelect={(value) => void selectKeyboardImplementation(value)}
                disabled={isUpdating("keyboard_implementation")}
              />
            </SettingRow>
            <ToggleRow
              settingKey="lazy_stream_close"
              title={t("settings.advanced.lazyStreamClose.label")}
              subtitle={t("settings.modal.hints.lazyStreamClose")}
            />
          </>
        )}
      </GroupCard>
    </>
  );
};
