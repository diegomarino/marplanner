/** Public default credentials (one-click deploys): the access gate prefills the default token and
 * warns, and the SPA shell carries a `<meta>` with the defaults still in use, so the provisioning
 * and admin PIN screens can do the same. An operator-chosen value must never reach the HTML.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app";
import {
  defaultCredentialsMetaTag,
  publicDefaultCredentials,
  resolveAdminPin,
  usesDefaultAccessToken,
} from "../../src/server/auth/default-credentials";
import {
  DEFAULT_CREDENTIALS_META,
  PUBLIC_DEFAULT_ACCESS_TOKEN,
  PUBLIC_DEFAULT_BOOTSTRAP_KEY,
} from "../../src/shared/default-credentials";
import { useIsolatedDb } from "../helpers/db";

const CUSTOM_TOKEN = "mpg-operator-chosen-token-7f3a";
const CUSTOM_KEY = "mpk-operator-chosen-key-91bc";
const CUSTOM_PIN = "8642";
const SHELL_SENTINEL = "APP_SHELL_SENTINEL";
const ENV_KEYS = ["MP_ACCESS_TOKEN", "MP_BOOTSTRAP_KEY", "MP_ADMIN_PIN"] as const;

describe("admin PIN environment variable", () => {
  it("reads the PIN from MP_ADMIN_PIN", () => {
    expect(resolveAdminPin({ MP_ADMIN_PIN: CUSTOM_PIN })).toBe(CUSTOM_PIN);
  });

  it("falls back to 0000 when MP_ADMIN_PIN is unset", () => {
    expect(resolveAdminPin({})).toBe("0000");
  });
});

describe("public default credential detection", () => {
  it("recognises only the repository's default access token", () => {
    expect(usesDefaultAccessToken({ MP_ACCESS_TOKEN: PUBLIC_DEFAULT_ACCESS_TOKEN })).toBe(true);
    expect(usesDefaultAccessToken({ MP_ACCESS_TOKEN: CUSTOM_TOKEN })).toBe(false);
    expect(usesDefaultAccessToken({})).toBe(false);
  });

  it("reports the default bootstrap key and either public PIN, including the unset fallback", () => {
    expect(
      publicDefaultCredentials({
        MP_BOOTSTRAP_KEY: PUBLIC_DEFAULT_BOOTSTRAP_KEY,
        MP_ADMIN_PIN: "0000",
      })
    ).toEqual({ bootstrapKey: PUBLIC_DEFAULT_BOOTSTRAP_KEY, adminPin: "0000" });
    expect(publicDefaultCredentials({ MP_ADMIN_PIN: "1234" })).toEqual({ adminPin: "1234" });
    // provision.ts seeds "0000" when MP_ADMIN_PIN is unset, so that PIN is public too.
    expect(publicDefaultCredentials({})).toEqual({ adminPin: "0000" });
  });

  it("never reports an operator-chosen value", () => {
    const credentials = publicDefaultCredentials({
      MP_ACCESS_TOKEN: CUSTOM_TOKEN,
      MP_BOOTSTRAP_KEY: CUSTOM_KEY,
      MP_ADMIN_PIN: CUSTOM_PIN,
    });
    expect(credentials).toEqual({});
    expect(JSON.stringify(credentials)).not.toMatch(/operator-chosen|8642/);
  });

  it("emits an attribute-safe meta tag, or nothing once every credential changed", () => {
    expect(
      defaultCredentialsMetaTag({
        MP_BOOTSTRAP_KEY: PUBLIC_DEFAULT_BOOTSTRAP_KEY,
        MP_ADMIN_PIN: "0000",
      })
    ).toBe(
      `<meta name="${DEFAULT_CREDENTIALS_META}" content="{&quot;bootstrapKey&quot;:&quot;${PUBLIC_DEFAULT_BOOTSTRAP_KEY}&quot;,&quot;adminPin&quot;:&quot;0000&quot;}">`
    );
    expect(
      defaultCredentialsMetaTag({ MP_BOOTSTRAP_KEY: CUSTOM_KEY, MP_ADMIN_PIN: CUSTOM_PIN })
    ).toBe("");
  });
});

describe("auth screens served with public defaults or chosen credentials", () => {
  const fixtureDb = useIsolatedDb({ pluginState: "inactive" });
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const key of ENV_KEYS) delete process.env[key];
  });

  function useCredentials(token: string, bootstrapKey: string, pin: string): void {
    process.env.MP_ACCESS_TOKEN = token;
    process.env.MP_BOOTSTRAP_KEY = bootstrapKey;
    process.env.MP_ADMIN_PIN = pin;
  }

  async function start(): Promise<FastifyInstance> {
    const staticRoot = join(fixtureDb.dir(), "static");
    mkdirSync(staticRoot, { recursive: true });
    writeFileSync(
      join(staticRoot, "index.html"),
      `<!doctype html><html><head><title>t</title></head><body>${SHELL_SENTINEL}</body></html>`
    );
    app = await buildApp({ staticRoot });
    return app;
  }

  async function shellHtml(server: FastifyInstance, token: string): Promise<string> {
    const gate = await server.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${token}`,
    });
    expect(gate.statusCode).toBe(303);
    const cookie = String(gate.headers["set-cookie"]).match(/mp_gate=[^;]+/)?.[0] ?? "";
    const shell = await server.inject({ method: "GET", url: "/", headers: { cookie } });
    expect(shell.body).toContain(SHELL_SENTINEL);
    return shell.body;
  }

  it("prefills the default token on the gate and warns, on first view and after a wrong try", async () => {
    useCredentials(PUBLIC_DEFAULT_ACCESS_TOKEN, PUBLIC_DEFAULT_BOOTSTRAP_KEY, "0000");
    const server = await start();

    const form = await server.inject({ method: "GET", url: "/" });
    expect(form.body).toContain('data-testid="access-gate-default-notice"');
    expect(form.body).toContain(`value="${PUBLIC_DEFAULT_ACCESS_TOKEN}"`);
    expect(form.body).toContain("MP_ACCESS_TOKEN");

    const retry = await server.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=wrong",
    });
    expect(retry.body).toContain('data-testid="access-gate-default-notice"');
  });

  it("passes the public defaults to the SPA shell next to the base path", async () => {
    useCredentials(PUBLIC_DEFAULT_ACCESS_TOKEN, PUBLIC_DEFAULT_BOOTSTRAP_KEY, "0000");
    const html = await shellHtml(await start(), PUBLIC_DEFAULT_ACCESS_TOKEN);
    expect(html).toMatch(
      new RegExp(
        `<meta name="mp-base-path" content="[^"]*"><meta name="${DEFAULT_CREDENTIALS_META}"`
      )
    );
    expect(html).toContain(PUBLIC_DEFAULT_BOOTSTRAP_KEY);
    // The access token is never needed past the gate, so the shell does not repeat it.
    expect(html).not.toContain(PUBLIC_DEFAULT_ACCESS_TOKEN);
  });

  it("shows no notice, no prefill and no meta tag once every credential is chosen", async () => {
    useCredentials(CUSTOM_TOKEN, CUSTOM_KEY, CUSTOM_PIN);
    const server = await start();

    const form = await server.inject({ method: "GET", url: "/" });
    expect(form.body).toContain("access-gate-form");
    expect(form.body).not.toContain("access-gate-default-notice");
    expect(form.body).not.toContain("value=");
    expect(form.body).not.toContain(CUSTOM_TOKEN);

    const html = await shellHtml(server, CUSTOM_TOKEN);
    expect(html).not.toContain(DEFAULT_CREDENTIALS_META);
    for (const secret of [CUSTOM_TOKEN, CUSTOM_KEY, CUSTOM_PIN]) expect(html).not.toContain(secret);
  });

  it("reports only the credentials still at their default when some were changed", async () => {
    useCredentials(CUSTOM_TOKEN, PUBLIC_DEFAULT_BOOTSTRAP_KEY, CUSTOM_PIN);
    const server = await start();

    const form = await server.inject({ method: "GET", url: "/" });
    expect(form.body).not.toContain("access-gate-default-notice");

    const html = await shellHtml(server, CUSTOM_TOKEN);
    expect(html).toContain(PUBLIC_DEFAULT_BOOTSTRAP_KEY);
    expect(html).not.toContain("adminPin");
    expect(html).not.toContain(CUSTOM_PIN);
  });
});
