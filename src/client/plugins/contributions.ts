import { Component, createElement, type ErrorInfo, type ReactNode } from "react";

import type { PluginCatalogEntry, PluginContributionSummary, PluginId } from "../../shared/plugins";
import { useOptionalPluginCatalog } from "./PluginCatalogProvider";
import { PluginUnavailable } from "./PluginUnavailable";

export type PluginContributionGroup = keyof PluginContributionSummary;

export function isContributionActive(
  plugins: readonly PluginCatalogEntry[],
  pluginId: PluginId,
  group?: PluginContributionGroup,
  contributionId?: string
): boolean {
  const plugin = plugins.find((candidate) => candidate.id === pluginId);
  if (plugin?.state !== "active") return false;
  if (group === undefined || contributionId === undefined) return true;
  return plugin.contributions[group].includes(contributionId);
}

export function usePluginActive(pluginId: PluginId): boolean {
  const catalog = useOptionalPluginCatalog();
  if (catalog === null) return true;
  return catalog.status === "ready" && isContributionActive(catalog.plugins, pluginId);
}

export function usePluginContributionActive(
  pluginId: PluginId,
  group: PluginContributionGroup,
  contributionId: string
): boolean {
  const catalog = useOptionalPluginCatalog();
  // Standalone component tests and legacy embedders have no authenticated catalog owner.
  // Preserve their static inventory; the production Shell always supplies the provider.
  if (catalog === null) return true;
  return (
    catalog.status === "ready" &&
    isContributionActive(catalog.plugins, pluginId, group, contributionId)
  );
}

interface BoundaryProps {
  pluginId: PluginId;
  reportFault: (pluginId: PluginId, code: "contribution_render_failed") => Promise<void>;
  fallback: ReactNode;
  children: ReactNode;
}

class PluginRenderBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    void this.props.reportFault(this.props.pluginId, "contribution_render_failed");
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface PluginContributionProps {
  pluginId: PluginId;
  group: PluginContributionGroup;
  contributionId: string;
  direct?: boolean;
  withdrawnFallback?: ReactNode;
  errorFallback?: ReactNode;
  children: ReactNode;
}

export function PluginContribution({
  pluginId,
  group,
  contributionId,
  direct = false,
  withdrawnFallback,
  errorFallback,
  children,
}: PluginContributionProps): ReactNode {
  const catalog = useOptionalPluginCatalog();
  const active =
    catalog?.status === "ready" &&
    isContributionActive(catalog.plugins, pluginId, group, contributionId);
  const unavailable = withdrawnFallback ?? (direct ? createElement(PluginUnavailable) : null);

  if (catalog === null) return children;
  if (!active) return unavailable;

  return createElement(PluginRenderBoundary, {
    key: `${pluginId}:${catalog.plugins.find((plugin) => plugin.id === pluginId)?.updatedAt ?? "missing"}`,
    pluginId,
    reportFault: catalog.reportFault,
    fallback: errorFallback ?? createElement(PluginUnavailable),
    children,
  });
}
