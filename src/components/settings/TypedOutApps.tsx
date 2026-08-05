import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { SettingContainer } from "../ui/SettingContainer";

interface TypedOutAppsProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

/**
 * Apps that get the transcript typed out rather than dropped in one go,
 * listed by bundle identifier. Nobody knows those by heart, so the app the
 * last transcript landed in is offered for adding.
 */
export const TypedOutApps: React.FC<TypedOutAppsProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();
    const [newApp, setNewApp] = useState("");
    const [lastTarget, setLastTarget] = useState<string | null>(null);
    const apps = getSetting("typed_out_apps") || [];

    useEffect(() => {
      let cancelled = false;
      const poll = async () => {
        const target = await commands.getLastPasteTarget().catch(() => null);
        if (!cancelled) setLastTarget(target);
      };
      poll();
      const timer = setInterval(poll, 3000);
      return () => {
        cancelled = true;
        clearInterval(timer);
      };
    }, []);

    const addApp = (candidate: string) => {
      const bundleId = candidate.trim();
      if (!bundleId) return;
      if (apps.some((app) => app.toLowerCase() === bundleId.toLowerCase())) {
        toast.error(t("settings.advanced.typedOutApps.duplicate"));
        return;
      }
      updateSetting("typed_out_apps", [...apps, bundleId]);
      setNewApp("");
    };

    const removeApp = (bundleId: string) => {
      updateSetting(
        "typed_out_apps",
        apps.filter((app) => app !== bundleId),
      );
    };

    const canAddLastTarget =
      lastTarget !== null &&
      !apps.some((app) => app.toLowerCase() === lastTarget.toLowerCase());

    return (
      <>
        <SettingContainer
          title={t("settings.advanced.typedOutApps.title")}
          description={t("settings.advanced.typedOutApps.description")}
          descriptionMode={descriptionMode}
          grouped={grouped}
        >
          <div className="flex items-center gap-2">
            <Input
              type="text"
              className="max-w-56"
              value={newApp}
              onChange={(e) => setNewApp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addApp(newApp);
                }
              }}
              placeholder={t("settings.advanced.typedOutApps.placeholder")}
              variant="compact"
              disabled={isUpdating("typed_out_apps")}
            />
            <Button
              onClick={() => addApp(newApp)}
              disabled={!newApp.trim() || isUpdating("typed_out_apps")}
              variant="primary"
              size="md"
            >
              {t("settings.advanced.typedOutApps.add")}
            </Button>
          </div>
        </SettingContainer>

        {(apps.length > 0 || canAddLastTarget) && (
          <div
            className={`px-4 p-2 ${grouped ? "" : "rounded-lg border border-mid-gray/20"} flex flex-wrap items-center gap-1`}
          >
            {apps.map((app) => (
              <Button
                key={app}
                onClick={() => removeApp(app)}
                disabled={isUpdating("typed_out_apps")}
                variant="secondary"
                size="sm"
                className="inline-flex items-center gap-1 cursor-pointer"
                aria-label={t("settings.advanced.typedOutApps.remove", {
                  app,
                })}
              >
                <span>{app}</span>
                <X className="w-3 h-3" />
              </Button>
            ))}
            {canAddLastTarget && (
              <Button
                onClick={() => addApp(lastTarget)}
                disabled={isUpdating("typed_out_apps")}
                variant="ghost"
                size="sm"
                className="cursor-pointer"
              >
                {t("settings.advanced.typedOutApps.addLast", {
                  app: lastTarget,
                })}
              </Button>
            )}
          </div>
        )}
      </>
    );
  },
);
