import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSettings } from "../../hooks/useSettings";
import { PillButton, SoftCard } from "../ui";
import { TagList, TextField } from "./modal/controls";

interface CustomWordsProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

const normalizeCustomWord = (word: string) =>
  word
    .replace(/[<>"']/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The dictionary: names and terms the model should get right. Re-skinned to the
 * ported vocabulary — a cream card holding the add row and the words already in
 * it — while the list itself is still just the `custom_words` setting.
 *
 * Exported both ways: the settings barrel imports it by name, the app shell's
 * Dictionary page imports the default.
 */
export const CustomWords: React.FC<CustomWordsProps> = React.memo(() => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const [newWord, setNewWord] = useState("");
  const customWords = getSetting("custom_words") || [];
  const normalizedWord = normalizeCustomWord(newWord);

  const handleAddWord = () => {
    if (!normalizedWord || normalizedWord.length > 50) return;
    if (customWords.includes(normalizedWord)) {
      toast.error(
        t("settings.advanced.customWords.duplicate", { word: normalizedWord }),
      );
      return;
    }
    void updateSetting("custom_words", [...customWords, normalizedWord]);
    setNewWord("");
  };

  return (
    <SoftCard variant="inset">
      <div
        className="flex items-center justify-between gap-[var(--fs-row-px)]"
        style={{
          minHeight: "var(--fs-row-h-stacked)",
          paddingInline: "var(--fs-row-px)",
          fontFamily: "var(--fs-font-sans)",
          borderBottom: customWords.length
            ? "1px solid var(--fs-hairline)"
            : undefined,
        }}
      >
        <div className="min-w-0">
          <div
            style={{
              fontSize: "var(--fs-text-body)",
              fontWeight: 600,
              lineHeight: "21px",
              color: "var(--fs-ink)",
            }}
          >
            {t("settings.advanced.customWords.title")}
          </div>
          <div
            style={{
              fontSize: "var(--fs-text-body)",
              lineHeight: "21px",
              marginTop: "5px",
              color: "var(--fs-ink-secondary)",
            }}
          >
            {t("settings.advanced.customWords.description")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-[8px]">
          <TextField
            value={newWord}
            ariaLabel={t("settings.advanced.customWords.title")}
            placeholder={t("settings.advanced.customWords.placeholder")}
            onChange={setNewWord}
            onSubmit={handleAddWord}
            disabled={isUpdating("custom_words")}
          />
          <PillButton
            onClick={handleAddWord}
            disabled={
              !normalizedWord ||
              normalizedWord.length > 50 ||
              isUpdating("custom_words")
            }
          >
            {t("settings.advanced.customWords.add")}
          </PillButton>
        </div>
      </div>
      <TagList
        items={customWords}
        disabled={isUpdating("custom_words")}
        removeLabel={(word) =>
          t("settings.advanced.customWords.remove", { word })
        }
        onRemove={(word) =>
          void updateSetting(
            "custom_words",
            customWords.filter((entry) => entry !== word),
          )
        }
      />
    </SoftCard>
  );
});

CustomWords.displayName = "CustomWords";

export default CustomWords;
