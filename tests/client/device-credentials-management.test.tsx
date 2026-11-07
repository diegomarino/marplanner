import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceCredentialsManagement } from "@/admin/DeviceCredentialsManagement";
import { LanguageProvider } from "@/i18n";
import { CREDENTIAL_LOST_EVENT } from "@/lib/credential";
import type { DeviceCredential } from "../../src/shared";

/** Access keys admin panel (issue #95): list, filter, rename and revoke credentials. */

const currentSettings = { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 };

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettings: () => currentSettings,
  useHouseholdSettingsContext: () => currentSettings,
}));

type FetchCall = Parameters<typeof globalThis.fetch>;

function credential(overrides: Partial<DeviceCredential> = {}): DeviceCredential {
  return {
    id: "kitchen",
    kind: "device",
    label: "Kitchen tablet",
    createdAt: Date.parse("2026-10-21T12:00:00Z"),
    expiresAt: null,
    state: "active",
    current: false,
    configuredBootstrap: false,
    ...overrides,
  };
}

const LIST = [
  credential({ id: "admin", label: "Hallway screen", current: true }),
  credential(),
  credential({ id: "boot", kind: "bootstrap", label: null, configuredBootstrap: true }),
  credential({ id: "old", label: "Old phone", state: "revoked" }),
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

let fetchMock: ReturnType<typeof vi.fn<(...args: FetchCall) => Promise<Response>>>;

function routeFetch(handlers: {
  revoke?: (id: string) => Response;
  label?: (id: string, body: { label: string }) => Response;
}) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/auth/credentials") return json({ credentials: LIST });
    const revoke = /^\/api\/auth\/credentials\/([^/]+)\/revoke$/.exec(url);
    if (revoke && handlers.revoke) return handlers.revoke(revoke[1]);
    const label = /^\/api\/auth\/credentials\/([^/]+)$/.exec(url);
    if (label && init?.method === "PATCH" && handlers.label) {
      return handlers.label(label[1], JSON.parse(String(init.body)) as { label: string });
    }
    return json({ error: "unexpected" }, 500);
  });
}

function renderPanel() {
  render(
    <LanguageProvider>
      <DeviceCredentialsManagement />
    </LanguageProvider>
  );
}

beforeEach(() => {
  fetchMock = vi.fn<(...args: FetchCall) => Promise<Response>>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DeviceCredentialsManagement", () => {
  it("lists credentials, marks this device and hides revoked keys behind a filter", async () => {
    routeFetch({});
    renderPanel();

    await screen.findByTestId("access-keys-list");
    expect(screen.getByTestId("access-keys-name-admin")).toHaveTextContent("Hallway screen");
    expect(screen.getByTestId("access-keys-current-admin")).toHaveTextContent("This device");
    expect(screen.queryByTestId("access-keys-current-kitchen")).not.toBeInTheDocument();
    expect(screen.getByTestId("access-keys-name-boot")).toHaveTextContent("Unnamed key");
    expect(screen.queryByTestId("access-keys-row-old")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Show revoked (1)"));
    const revoked = await screen.findByTestId("access-keys-row-old");
    expect(within(revoked).getByTestId("access-keys-state-old")).toHaveTextContent("Revoked");
    expect(within(revoked).queryByTestId("access-keys-revoke-old")).not.toBeInTheDocument();
  });

  it("shows when each key was added to the minute, in the household timezone", async () => {
    routeFetch({});
    renderPanel();

    expect(await screen.findByTestId("access-keys-created-kitchen")).toHaveTextContent(
      "Added 21 Oct 2026, 14:00"
    );
    cleanup();

    currentSettings.timezone = "America/New_York";
    try {
      renderPanel();
      expect(await screen.findByTestId("access-keys-created-kitchen")).toHaveTextContent(
        "Added 21 Oct 2026, 08:00"
      );
    } finally {
      currentSettings.timezone = "Europe/Madrid";
    }
  });

  it("disables revoking the configured bootstrap key and explains how to rotate it", async () => {
    routeFetch({});
    renderPanel();

    expect(await screen.findByTestId("access-keys-revoke-boot")).toBeDisabled();
    expect(screen.getByTestId("access-keys-bootstrap-note-boot")).toHaveTextContent(
      /change the variable and restart, then revoke this old key/
    );
    expect(screen.getByTestId("access-keys-revoke-kitchen")).toBeEnabled();
  });

  it("revokes another device only after confirmation", async () => {
    const revoked: string[] = [];
    routeFetch({
      revoke: (id) => {
        revoked.push(id);
        return json({ credential: credential({ state: "revoked" }), revoked: true });
      },
    });
    const lost = vi.fn();
    window.addEventListener(CREDENTIAL_LOST_EVENT, lost);
    renderPanel();

    fireEvent.click(await screen.findByTestId("access-keys-revoke-kitchen"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Revoke “Kitchen tablet”?");
    expect(dialog).toHaveTextContent(/stops working on its next request/);
    fireEvent.click(screen.getByTestId("access-keys-revoke-cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(revoked).toEqual([]);

    fireEvent.click(screen.getByTestId("access-keys-revoke-kitchen"));
    fireEvent.click(await screen.findByTestId("access-keys-revoke-confirm"));
    await waitFor(() => expect(screen.queryByTestId("access-keys-row-kitchen")).toBeNull());
    expect(revoked).toEqual(["kitchen"]);
    expect(lost).not.toHaveBeenCalled();
    window.removeEventListener(CREDENTIAL_LOST_EVENT, lost);
  });

  it("warns before revoking this device and logs the screen out afterwards", async () => {
    routeFetch({
      revoke: () =>
        json({
          credential: credential({ id: "admin", current: true, state: "revoked" }),
          revoked: true,
        }),
    });
    const lost = vi.fn();
    window.addEventListener(CREDENTIAL_LOST_EVENT, lost);
    renderPanel();

    fireEvent.click(await screen.findByTestId("access-keys-revoke-admin"));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      /the device you are using now\. Revoking it logs this screen out/
    );
    const confirm = screen.getByTestId("access-keys-revoke-confirm");
    expect(confirm).toHaveTextContent("Revoke and log out");
    fireEvent.click(confirm);
    await waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
    window.removeEventListener(CREDENTIAL_LOST_EVENT, lost);
  });

  it("shows the bootstrap explanation, not a generic error, when the server refuses", async () => {
    routeFetch({
      revoke: () => json({ code: "configured_bootstrap", message: "change the variable" }, 409),
    });
    renderPanel();

    fireEvent.click(await screen.findByTestId("access-keys-revoke-kitchen"));
    fireEvent.click(await screen.findByTestId("access-keys-revoke-confirm"));
    expect(await screen.findByTestId("access-keys-row-error-kitchen")).toHaveTextContent(
      /configured MP_BOOTSTRAP_KEY/
    );
  });

  it("renames a credential and rejects an empty name locally", async () => {
    const labels: string[] = [];
    routeFetch({
      label: (id, body) => {
        labels.push(body.label);
        return json(credential({ id, label: body.label }));
      },
    });
    renderPanel();

    fireEvent.click(await screen.findByTestId("access-keys-rename-kitchen"));
    const input = await screen.findByTestId("access-keys-rename-input");
    expect(input).toHaveValue("Kitchen tablet");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("access-keys-rename-save"));
    expect(await screen.findByTestId("access-keys-rename-error")).toHaveTextContent(
      "Enter a name."
    );
    expect(labels).toEqual([]);

    fireEvent.change(input, { target: { value: " Fridge door " } });
    fireEvent.click(screen.getByTestId("access-keys-rename-save"));
    await waitFor(() =>
      expect(screen.getByTestId("access-keys-name-kitchen")).toHaveTextContent("Fridge door")
    );
    expect(labels).toEqual(["Fridge door"]);
  });

  it("shows a retryable error when the list cannot load", async () => {
    fetchMock.mockResolvedValueOnce(json({ code: "boom" }, 500));
    renderPanel();

    expect(await screen.findByTestId("access-keys-error")).toHaveTextContent(
      "Failed to load access keys."
    );
    routeFetch({});
    fireEvent.click(screen.getByTestId("access-keys-retry"));
    expect(await screen.findByTestId("access-keys-list")).toBeInTheDocument();
  });
});
