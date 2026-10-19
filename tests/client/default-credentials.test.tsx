/** Public default credentials on the client: the server's `mp-default-credentials` meta tag lets
 * the provisioning screen prefill the default bootstrap key and the admin PIN screen show the
 * default PIN, each with a notice that it must be changed. Values outside the known public set
 * are ignored, so a tampered page can never prefill or display anything else.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminGate } from "@/admin/AdminGate";
import { messages } from "@/i18n/messages";
import { AdminUnlockProvider } from "@/lib/adminUnlock";
import { readPublicDefaultCredentials } from "@/lib/default-credentials";
import { ProvisioningScreen } from "@/shell/Shell";

const DEFAULT_KEY = "mpk-local-bootstrap-change-me";

function setMeta(content: string | null): void {
  document.head.querySelector('meta[name="mp-default-credentials"]')?.remove();
  if (content === null) return;
  const meta = document.createElement("meta");
  meta.name = "mp-default-credentials";
  meta.content = content;
  document.head.append(meta);
}

function stubBrowserLanguage(value: string): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, "language");
  Object.defineProperty(navigator, "language", { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(navigator, "language", original);
    // @ts-expect-error test-only cleanup of a property this helper itself defined
    else delete navigator.language;
  };
}

function renderProvisioning() {
  return render(<ProvisioningScreen onProvision={() => {}} provisioning={false} error={false} />);
}

function renderAdminGate() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ locale: { language: "en" } }))))
  );
  return render(
    <AdminUnlockProvider>
      <AdminGate />
    </AdminUnlockProvider>
  );
}

afterEach(() => {
  cleanup();
  setMeta(null);
  vi.unstubAllGlobals();
});

describe("readPublicDefaultCredentials", () => {
  it("reads the public defaults the server reported", () => {
    setMeta(JSON.stringify({ bootstrapKey: DEFAULT_KEY, adminPin: "0000" }));
    expect(readPublicDefaultCredentials()).toEqual({ bootstrapKey: DEFAULT_KEY, adminPin: "0000" });
    setMeta(JSON.stringify({ adminPin: "1234" }));
    expect(readPublicDefaultCredentials()).toEqual({ adminPin: "1234" });
  });

  it("returns nothing without the tag or with malformed content", () => {
    expect(readPublicDefaultCredentials()).toEqual({});
    for (const content of ["", "not json", "null", '"string"', "[1]"]) {
      setMeta(content);
      expect(readPublicDefaultCredentials()).toEqual({});
    }
  });

  it("drops any value outside the known public set", () => {
    setMeta(JSON.stringify({ bootstrapKey: "mpk-real-secret", adminPin: "8642" }));
    expect(readPublicDefaultCredentials()).toEqual({});
    setMeta(JSON.stringify({ bootstrapKey: DEFAULT_KEY, adminPin: 0 }));
    expect(readPublicDefaultCredentials()).toEqual({ bootstrapKey: DEFAULT_KEY });
  });
});

describe("ProvisioningScreen with a public default bootstrap key", () => {
  it("prefills the key and shows the English notice", () => {
    setMeta(JSON.stringify({ bootstrapKey: DEFAULT_KEY, adminPin: "0000" }));
    renderProvisioning();
    expect(screen.getByLabelText(messages.en["provisioning.gate.bootstrapKeyLabel"])).toHaveValue(
      DEFAULT_KEY
    );
    expect(screen.getByTestId("provisioning-gate-default-notice")).toHaveTextContent(
      messages.en["provisioning.gate.defaultKeyNotice"]
    );
  });

  it("follows the browser language for the notice", () => {
    setMeta(JSON.stringify({ bootstrapKey: DEFAULT_KEY }));
    const restore = stubBrowserLanguage("es-ES");
    try {
      renderProvisioning();
      expect(screen.getByTestId("provisioning-gate-default-notice")).toHaveTextContent(
        messages.es["provisioning.gate.defaultKeyNotice"]
      );
      expect(messages.es["provisioning.gate.defaultKeyNotice"]).not.toBe(
        messages.en["provisioning.gate.defaultKeyNotice"]
      );
    } finally {
      restore();
    }
  });

  it("starts empty with no notice when the key was changed or the tag was tampered with", () => {
    for (const content of [null, JSON.stringify({ adminPin: "0000" }), '{"bootstrapKey":"x"}']) {
      setMeta(content);
      renderProvisioning();
      expect(screen.getByLabelText(messages.en["provisioning.gate.bootstrapKeyLabel"])).toHaveValue(
        ""
      );
      expect(screen.queryByTestId("provisioning-gate-default-notice")).toBeNull();
      cleanup();
    }
  });
});

describe("AdminGate with a public default PIN", () => {
  it("shows the default PIN in the English notice", () => {
    setMeta(JSON.stringify({ adminPin: "0000" }));
    renderAdminGate();
    const notice = screen.getByTestId("admin-pin-default-notice");
    expect(notice).toHaveTextContent("public default PIN 0000");
    expect(notice).toHaveTextContent("ADMIN_PIN");
  });

  it("shows no notice when the PIN was changed or the tag carries an unknown PIN", () => {
    for (const content of [null, JSON.stringify({ adminPin: "8642" })]) {
      setMeta(content);
      renderAdminGate();
      expect(screen.getByTestId("admin-pin-keypad")).toBeInTheDocument();
      expect(screen.queryByTestId("admin-pin-default-notice")).toBeNull();
      expect(document.body.textContent).not.toContain("8642");
      cleanup();
    }
  });
});
