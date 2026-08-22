import React from "react";
import { useTranslation } from "react-i18next";
import { CustomWords } from "../settings";
import { PageShell } from "../home/PageShell";

/**
 * The custom-words list, promoted out of Advanced settings into its own page.
 * The existing component is mounted as-is — its logic is untouched.
 */
export const DictionaryPage: React.FC = () => {
  const { t } = useTranslation();

  return (
    <PageShell title={t("shell.dictionary.title")}>
      <CustomWords descriptionMode="inline" />
    </PageShell>
  );
};
