import type { PluginPublicError, PluginPublicErrorCode } from "../../shared/plugins.js";

export const SAFE_LIFECYCLE_ERRORS: Readonly<Record<PluginPublicErrorCode, PluginPublicError>> = {
  settings_initialization_failed: {
    code: "settings_initialization_failed",
    message: "Plugin settings could not be prepared.",
  },
  migration_failed: {
    code: "migration_failed",
    message: "Plugin data could not be prepared.",
  },
  runtime_mount_failed: {
    code: "runtime_mount_failed",
    message: "Plugin services could not be started.",
  },
  drain_failed: {
    code: "drain_failed",
    message: "Plugin work could not stop safely.",
  },
  runtime_unmount_failed: {
    code: "runtime_unmount_failed",
    message: "Plugin services could not be stopped.",
  },
  contribution_failed: {
    code: "contribution_failed",
    message: "A plugin contribution failed.",
  },
  reconciliation_failed: {
    code: "reconciliation_failed",
    message: "Plugin recovery requires attention.",
  },
};

export class PluginLifecycleError extends Error {
  readonly code: PluginPublicErrorCode;

  constructor(code: PluginPublicErrorCode) {
    const error = SAFE_LIFECYCLE_ERRORS[code];
    super(error.message);
    this.name = "PluginLifecycleError";
    this.code = error.code;
  }
}

export class PluginLifecycleBusyError extends Error {
  readonly code = "plugin_lifecycle_busy" as const;

  constructor() {
    super("Plugin lifecycle operation is already in progress.");
    this.name = "PluginLifecycleBusyError";
  }
}
