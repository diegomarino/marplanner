import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import type { LiveCacheState, RegisteredDevice } from "../../../shared";

function formatLastSeen(lastSeenAt: number, language: string): string {
  return new Date(lastSeenAt).toLocaleString(language === "es" ? "es-ES" : "en-GB");
}

function cacheStateMessageKey(state: LiveCacheState): MessageKey {
  if (state === "unconfigured") return "networkDevices.cacheState.unconfigured";
  if (state === "cold") return "networkDevices.cacheState.cold";
  if (state === "stale") return "networkDevices.cacheState.stale";
  if (state === "freshEmpty") return "networkDevices.cacheState.freshEmpty";
  return "networkDevices.cacheState.fresh";
}

/** liveStatus (online/notDetected/unknown) + belief-divergence affordance, never inventing a
 * status. The dot is decorative (`aria-hidden`): the text label stays the accessible carrier, so
 * colour is never the sole signal. Last-seen is shown for unknown/not-detected rows only, never
 * as live online evidence. */
export function DeviceStatus({
  device,
  cacheState,
  attemptedBlockTarget,
}: {
  device: RegisteredDevice;
  cacheState: LiveCacheState | null;
  /** the AUTHORITATIVE target of the most recent LOCAL block/unblock action for
   * this device (`true` = the action was targeting "blocked"), or `undefined` when this row
   * has no locally-attempted action to trust (e.g. arrived already-divergent from a page load). */
  attemptedBlockTarget?: boolean;
}) {
  const { t, language } = useTranslation();
  const liveStatusKey: MessageKey =
    device.liveStatus === "online"
      ? "networkDevices.liveStatus.online"
      : device.liveStatus === "notDetected"
        ? "networkDevices.liveStatus.notDetected"
        : "networkDevices.liveStatus.unknown";

  let blockBadge: string | null = null;
  if (device.beliefDiverged) {
    // The response's OWN `isBlocked` is the pre-divergence (stale) belief, not the outcome — the
    // controller call itself is what succeeded. When THIS session attempted the action, trust
    // that authoritative target instead. When it didn't (a load-time divergent row has no local
    // action to trust either direction from), render a NEUTRAL label that names neither state —
    // guessing here would be the exact bug this fix corrects.
    blockBadge =
      attemptedBlockTarget === undefined
        ? t("networkDevices.badge.stateConfirming")
        : t(
            attemptedBlockTarget
              ? "networkDevices.badge.blockedConfirming"
              : "networkDevices.badge.unblockedConfirming"
          );
  } else if (device.isBlocked) {
    blockBadge = t("networkDevices.badge.blocked");
  }

  return (
    <div
      className="text-control flex flex-wrap items-center gap-2"
      data-testid={`network-devices-status-${device.id}`}
    >
      <span aria-hidden="true" data-testid={`network-devices-dot-${device.id}`}>
        {device.liveStatus === "notDetected" ? (
          <span className="text-foreground">⚠</span>
        ) : (
          <span
            className={cn(
              "inline-block size-2.5 rounded-full",
              device.liveStatus === "online"
                ? device.isBlocked
                  ? "bg-destructive"
                  : "bg-success"
                : "bg-muted-foreground"
            )}
          />
        )}
      </span>
      <span className="rounded-full border px-2 py-0.5 text-xs">{t(liveStatusKey)}</span>
      {blockBadge && <span className="rounded-full border px-2 py-0.5 text-xs">{blockBadge}</span>}
      {/* lastSeenAt: deliberately NEVER shown next to "online" — only for notDetected/unknown,
          where the observation stamp is the useful signal. */}
      {device.liveStatus !== "online" &&
        (device.lastSeenAt === null ? (
          <span className="text-muted-foreground">{t("networkDevices.row.neverSeen")}</span>
        ) : (
          <span className="text-muted-foreground">
            {t("networkDevices.row.lastSeenLabel")} {formatLastSeen(device.lastSeenAt, language)}
          </span>
        ))}
      {/* "unknown" is derived from a NON-fresh cache — naming WHY it's unknown (cache
          unconfigured/cold/stale) is more useful than the bare word "unknown". */}
      {device.liveStatus === "unknown" && cacheState !== null && (
        <span className="text-muted-foreground">
          {t("networkDevices.row.cacheStateLabel")} {t(cacheStateMessageKey(cacheState))}
        </span>
      )}
    </div>
  );
}

export function MemberLabel({ device }: { device: RegisteredDevice }) {
  const { t } = useTranslation();
  if (device.memberId === null) {
    return (
      <div className="text-muted-foreground text-control">{t("networkDevices.member.none")}</div>
    );
  }
  return (
    <div className="text-muted-foreground text-control">
      {device.memberLabel}
      {device.memberInactive && <> ({t("networkDevices.member.inactive")})</>}
    </div>
  );
}
