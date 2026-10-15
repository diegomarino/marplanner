import { useEffect, useState } from "react";
import { useT } from "@/i18n";
import { authFetch } from "@/lib/credential";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/ErrorNotice";
import type { BriefingStatus } from "../../../shared";

type ImageState =
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "rendering" }
  | { kind: "missing" }
  | { kind: "noRaster" }
  | { kind: "failed" };

interface BriefingImageProps {
  memberId: string;
  date: string;
  /** Bumped by the caller to force a refetch (Show, after a regenerate). */
  version: number;
  /** The briefing's status when known — words the "no printable image" state. */
  status?: BriefingStatus;
}

const FRAME =
  "flex min-h-48 w-64 max-w-full flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-4 text-center text-sm text-muted-foreground";

/** Stored render with honest states (spec D7/D11): the status code decides what is shown. */
export function BriefingImage({ memberId, date, version, status }: BriefingImageProps) {
  const t = useT();
  const [state, setState] = useState<ImageState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const response = await authFetch(
          `/api/daily-briefing/${memberId}/${date}/preview.png?v=${version}.${attempt}`,
          { credentials: "include" }
        );
        if (cancelled) return;
        if (response.status === 200) {
          const blob = await response.blob();
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setState({ kind: "ready", url: objectUrl });
        } else if (response.status === 202) setState({ kind: "rendering" });
        else if (response.status === 404) setState({ kind: "missing" });
        else if (response.status === 409) setState({ kind: "noRaster" });
        else setState({ kind: "failed" });
      } catch {
        if (!cancelled) setState({ kind: "failed" });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [memberId, date, version, attempt]);

  if (state.kind === "ready") {
    return (
      <img
        data-testid="daily-briefing-admin-preview-image"
        src={state.url}
        alt={t("dailyBriefing.admin.previewImageAlt")}
        className="w-64 max-w-full shrink-0 rounded-lg border"
      />
    );
  }

  const retry = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="daily-briefing-image-retry"
      onClick={() => setAttempt((value) => value + 1)}
    >
      {t("dailyBriefing.admin.retry")}
    </Button>
  );

  return (
    <div data-testid="daily-briefing-image-state" data-state={state.kind} className={FRAME}>
      {state.kind === "loading" && <p role="status">{t("dailyBriefing.admin.imageLoading")}</p>}
      {state.kind === "rendering" && (
        <>
          <p role="status">{t("dailyBriefing.admin.imageRendering")}</p>
          {retry}
        </>
      )}
      {state.kind === "missing" && (
        <p>{t("dailyBriefing.admin.noBriefingForDate").replace("{date}", date)}</p>
      )}
      {state.kind === "noRaster" &&
        (status === "render-failed" ? (
          <ErrorNotice message={t("dailyBriefing.admin.imageRenderFailed")} politeness="polite" />
        ) : (
          <p>{t("dailyBriefing.admin.imageNoRaster")}</p>
        ))}
      {state.kind === "failed" && (
        <>
          <ErrorNotice message={t("dailyBriefing.admin.imageError")} politeness="polite" />
          {retry}
        </>
      )}
    </div>
  );
}
