/** Printing visibility follows the live plugin catalog when its provider is mounted.
 * Outside that provider, the authenticated status endpoint is the fallback: begin
 * hidden, accept a successful response, and retry failed reads with bounded backoff.
 * Unmount clears retry timers. Credential-loss handling remains owned by authFetch.
 */
import { useEffect, useState } from "react";
import { authFetch } from "@/lib/credential";
import { useOptionalPluginCatalog } from "@/plugins/PluginCatalogProvider";
import { isContributionActive } from "@/plugins/contributions";
import type { PrintingStatusResponse } from "../../shared";

/** Backoff schedule for a FAILED read (case (b) above) — the last entry repeats indefinitely. */
const RETRY_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;

export function usePrintingPluginActive(): boolean {
  const catalog = useOptionalPluginCatalog();
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (catalog !== null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    function scheduleRetry(): void {
      if (cancelled) return;
      const delay = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
      attempt += 1;
      timer = setTimeout(() => {
        void read();
      }, delay);
    }

    function read(): Promise<void> {
      return authFetch("/api/printing/status", { credentials: "include" })
        .then((res) => {
          if (!res.ok) throw new Error(`printing status: ${res.status}`);
          return res.json() as Promise<PrintingStatusResponse>;
        })
        .then((data) => {
          if (cancelled) return;
          // A successful read landed (case (a)) — authoritative, whatever it says. No retry
          // either way: `data.active === true` needs none, and a clean `false` answer is
          // authoritative for this fallback read, not a failed request to retry.
          setActive(data.active === true);
        })
        .catch(() => {
          // The read itself failed (case (b)) — network/non-2xx/malformed. Stay hidden and
          // retry with backoff; never treated as an authoritative "inactive" verdict.
          if (cancelled) return;
          setActive(false);
          scheduleRetry();
        });
    }

    void read();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [catalog]);

  if (catalog !== null) {
    return (
      catalog.status === "ready" &&
      isContributionActive(catalog.plugins, "printing", "services", "printing-executor")
    );
  }
  return active;
}
