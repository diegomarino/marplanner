import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import { authFetch } from "@/lib/credential";
import { LocalizedApiError, responseMessage } from "@/lib/api-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckboxField } from "@/components/CheckboxField";
import { ErrorNotice } from "@/components/ErrorNotice";

export interface AutomationSettings {
  generationTime: string;
  autoPrintBound: boolean;
}

/** Household-wide automatic generation (spec D10). Save is enabled only while the draft differs
 * from the stored values. The trigger is sent as a BINDING ("morning_complete" | null). */
export function BriefingAutomationCard({
  stored,
  onSaved,
}: {
  stored: AutomationSettings;
  onSaved: (next: AutomationSettings) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adopt new stored values (after a save) — never on mount, where a late passive effect could
  // wipe an edit made right after the card appeared.
  const shown = useRef(stored);
  useEffect(() => {
    if (
      shown.current.generationTime === stored.generationTime &&
      shown.current.autoPrintBound === stored.autoPrintBound
    ) {
      return;
    }
    shown.current = stored;
    setDraft(stored);
  }, [stored.generationTime, stored.autoPrintBound]);

  const dirty =
    draft.generationTime !== stored.generationTime ||
    draft.autoPrintBound !== stored.autoPrintBound;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const response = await authFetch("/api/daily-briefing/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          generationTime: draft.generationTime,
          autoPrintTrigger: draft.autoPrintBound ? "morning_complete" : null,
        }),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.admin.settingsSaveError"))
        );
      }
      const snapshot = (await response.json()) as {
        generationTime: string;
        autoPrintTrigger: "morning_complete" | null;
      };
      onSaved({
        generationTime: snapshot.generationTime,
        autoPrintBound: snapshot.autoPrintTrigger === "morning_complete",
      });
    } catch (cause) {
      setError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("dailyBriefing.admin.settingsSaveError")
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="daily-briefing-admin-settings">
      <CardHeader>
        <CardTitle>{t("dailyBriefing.admin.automationTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ErrorNotice message={error} data-testid="daily-briefing-admin-settings-error" />
        <Label className="flex flex-col items-start gap-1">
          {t("dailyBriefing.admin.generationTimeLabel")}
          <Input
            type="time"
            data-testid="daily-briefing-admin-generation-time"
            value={draft.generationTime}
            disabled={saving}
            onChange={(event) => setDraft({ ...draft, generationTime: event.target.value })}
            className="w-32"
          />
        </Label>
        <CheckboxField
          data-testid="daily-briefing-admin-trigger-binding"
          checked={draft.autoPrintBound}
          disabled={saving}
          onChange={(checked) => setDraft({ ...draft, autoPrintBound: checked })}
          label={t("dailyBriefing.admin.autoPrintLabel")}
        />
        <p className="text-sm text-muted-foreground">{t("dailyBriefing.admin.automationHint")}</p>
        <Button
          type="button"
          className="w-fit"
          data-testid="daily-briefing-admin-settings-save"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving
            ? t("dailyBriefing.admin.settingsSaving")
            : t("dailyBriefing.admin.settingsSaveButton")}
        </Button>
      </CardContent>
    </Card>
  );
}
