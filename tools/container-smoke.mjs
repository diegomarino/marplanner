#!/usr/bin/env node
// Acceptance consumes the image as built; it never builds or launches a host server.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { candidateIdentity } from "./candidate-identity.mjs";

const exec = promisify(execFile);
async function cleanupContainer(name, collect, remove) {
  const errors = [];
  try {
    await collect(name);
  } catch (error) {
    errors.push(error.message);
  }
  try {
    await remove(name);
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}
if (process.argv.includes("--self-check")) {
  let removed = false;
  const errors = await cleanupContainer(
    "owned",
    async () => {
      throw new Error("diagnostic failed");
    },
    async () => {
      removed = true;
    }
  );
  assert(removed, "diagnostic failure must not prevent resource removal");
  assert.equal(errors.length, 1);
  console.log("cleanup failure-path check passed");
  process.exit(0);
}
const args = process.argv.slice(2);
assert(
  args.length === 0 || (args.length === 2 && args[0] === "--image"),
  "usage: node tools/container-smoke.mjs [--image IMAGE]"
);
const requestedImage = args[1] ?? "marplanner:review";
let image = requestedImage;
const prefix = `mp-container-${randomUUID()}`;
const evidence = join(process.cwd(), ".quality/container", prefix);
const token = `mpg-${randomUUID()}`;
const bootstrap = `mpk-${randomUUID()}`;
const pin = "1234";
const containers = [];
const volumes = [];
const results = [];
let browser;
let readonlyDir;
let failed = false;
const redact = (text) =>
  String(text).replaceAll(token, "[access-redacted]").replaceAll(bootstrap, "[bootstrap-redacted]");
async function docker(...args) {
  try {
    const output = await exec("docker", args, { timeout: 150_000, maxBuffer: 16 * 1024 * 1024 });
    return (output.stdout + (args[0] === "logs" ? output.stderr : "")).trim();
  } catch (error) {
    throw new Error(redact(`docker ${args[0]} failed: ${error.stderr || error.message}`), {
      cause: error,
    });
  }
}
async function until(check, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`condition timed out after ${timeout}ms`);
}
async function caseRun(name, run) {
  try {
    await run();
    results.push({ name, status: "passed" });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: "failed", error: redact(error.stack) });
    throw error;
  }
}
async function volume(label) {
  const name = `${prefix}-${label}`;
  volumes.push(name);
  await docker("volume", "create", name);
  return name;
}
async function oneShot(label, args) {
  const name = `${prefix}-${label}`;
  containers.push(name);
  return docker("run", "--name", name, ...args);
}
async function start(label, storage, port = 3000, extra = [], credentials = true) {
  const name = `${prefix}-${label}`;
  containers.push(name);
  await docker(
    "create",
    "--name",
    name,
    "-p",
    `127.0.0.1::${port}`,
    "-v",
    storage.endsWith(":ro") ? `${storage.slice(0, -3)}:/data:ro` : `${storage}:/data`,
    "-e",
    `PORT=${port}`,
    "-e",
    "SCHEDULER_DISABLED=1",
    ...(credentials
      ? [
          "-e",
          `MP_ACCESS_TOKEN=${token}`,
          "-e",
          `MP_BOOTSTRAP_KEY=${bootstrap}`,
          "-e",
          `MP_ADMIN_PIN=${pin}`,
        ]
      : []),
    ...extra,
    image
  );
  await docker("start", name);
  const publication = await docker("port", name, `${port}/tcp`);
  assert.match(publication, /^127\.0\.0\.1:\d+$/);
  return { name, base: `http://localhost:${publication.split(":")[1]}` };
}
async function healthy(server) {
  await until(async () => {
    const state = JSON.parse(await docker("inspect", "--format", "{{json .State}}", server.name));
    assert(state.Running, "container exited before healthy");
    try {
      return (await fetch(`${server.base}/health`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  });
}
async function layout(page, label) {
  assert(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth
    ),
    "horizontal viewport overflow"
  );
  await page.screenshot({ path: join(evidence, `${label}.png`), fullPage: true });
}
async function provision(server, label, viewport, hasTouch = false) {
  const context = await browser.newContext({ viewport, hasTouch });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.base);
  await expect(page.getByTestId("access-gate-form")).toBeVisible();
  await expect(page.getByRole("button", { name: "Provision Device" })).toHaveCount(0);
  await layout(page, `${label}-gate`);
  await page.locator('input[name="token"]').fill(token);
  await page.locator('input[name="token"]').focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Enter", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.getByRole("button", { name: "Provision Device" })).toBeVisible();
  await layout(page, `${label}-provision`);
  await page.getByLabel("Bootstrap key").fill(bootstrap);
  await page.getByLabel("Bootstrap key").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Provision Device" })).toBeFocused();
  await page.getByRole("button", { name: "Provision Device" }).click();
  await expect(page.getByTestId("home-surface")).toBeVisible();
  const settings = await page.request.get(`${server.base}/api/settings`);
  assert.equal(settings.status(), 200);
  assert.match(JSON.stringify(await settings.json()), /Europe\/Madrid/);
  assert.deepEqual(errors, [], "uncaught browser errors");
  return { context, page };
}
await mkdir(evidence, { recursive: true });
const metadata = {
  requestedImage,
  observedSourceRevision: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
  results,
};
try {
  await caseRun("image identity and non-root runtime", async () => {
    const inspect = JSON.parse(await docker("image", "inspect", requestedImage))[0];
    image = inspect.Id;
    metadata.imageId = image;
    metadata.candidateIdentity = candidateIdentity();
    metadata.imageCandidateIdentity = inspect.Config.Labels?.["org.marplanner.candidate"];
    metadata.imageSourceRevision = inspect.Config.Labels?.["org.opencontainers.image.revision"];
    assert.equal(
      metadata.imageCandidateIdentity,
      metadata.candidateIdentity,
      "image candidate provenance mismatch or absent"
    );
    assert(metadata.imageSourceRevision, "image source revision label absent");
    metadata.platform = `${inspect.Os}/${inspect.Architecture}`;
    assert(inspect.Config.User && inspect.Config.User !== "root" && inspect.Config.User !== "0");
    const uid = await oneShot("uid", [
      "--entrypoint",
      "node",
      image,
      "-e",
      "if(process.getuid()===0)process.exit(1);console.log(process.getuid())",
    ]);
    assert(Number(uid) > 0);
    assert(!JSON.stringify(inspect.Config).includes(token));
  });
  browser = await chromium.launch();
  const store = await volume("primary");
  const primary = await start("primary", store);
  let session;
  await caseRun("fresh gate, provisioning, admin and member", async () => {
    await healthy(primary);
    assert.equal((await fetch(`${primary.base}/api/members`)).status, 401);
    session = await provision(primary, "desktop", { width: 1280, height: 900 });
    const { page } = session;
    await page.getByRole("button", { name: /options|opciones/i }).click();
    const admin = page.getByTestId("admin-affordance");
    await admin.hover();
    await page.mouse.down();
    try {
      await expect(page).toHaveURL(/\/admin$/, { timeout: 6000 });
    } finally {
      await page.mouse.up();
    }
    await expect(page.getByTestId("admin-pin-keypad")).toBeVisible();
    for (const digit of pin) await page.getByTestId(`admin-pin-digit-${digit}`).click();
    await page.getByTestId("admin-pin-unlock").click();
    await page.getByTestId("admin-nav-members-management").click();
    await page.getByTestId("members-add-member").click();
    await page.locator("#member-edit-display-name").fill("Container Ada");
    await page.locator("#member-edit-role").click();
    await page.getByRole("option").first().click();
    await page.getByTestId("member-save").click();
    await expect(page.getByTestId("member-form-dialog")).toBeHidden();
    await expect(page.getByTestId("members-card-grid")).toContainText("Container Ada");
    const response = await page.request.get(`${primary.base}/api/members`);
    assert.equal(response.status(), 200);
    assert((await response.json()).some((member) => member.displayName === "Container Ada"));
  });
  await caseRun("same-volume restart preserves device and member", async () => {
    await docker("stop", "--time", "15", primary.name);
    assert.equal(await docker("inspect", "--format", "{{.State.ExitCode}}", primary.name), "0");
    await docker("start", primary.name);
    const publication = await docker("port", primary.name, "3000/tcp");
    primary.base = `http://localhost:${publication.split(":")[1]}`;
    await healthy(primary);
    await session.page.goto(`${primary.base}/admin`);
    await expect(session.page.getByTestId("admin-pin-keypad")).toBeVisible();
    const response = await session.page.request.get(`${primary.base}/api/members`);
    assert.equal(response.status(), 200);
    assert((await response.json()).some((member) => member.displayName === "Container Ada"));
    await docker(
      "exec",
      primary.name,
      "node",
      "-e",
      `const D=require('better-sqlite3');const d=new D('/data/marplanner.db',{readonly:true});if(!d.prepare("SELECT 1 FROM members WHERE display_name='Container Ada'").get()||d.prepare('SELECT COUNT(*) n FROM api_keys WHERE revoked_at IS NULL').get().n<1)process.exit(1);d.close()`
    );
  });
  await caseRun("independent volume, touch flow and custom PORT healthcheck", async () => {
    const second = await start("independent", await volume("independent"), 3456);
    await healthy(second);
    assert.notEqual(second.base, primary.base);
    const touch = await provision(second, "touch", { width: 390, height: 844 }, true);
    const response = await touch.page.request.get(`${second.base}/api/members`);
    assert.equal(response.status(), 200);
    assert(!(await response.json()).some((member) => member.displayName === "Container Ada"));
    await until(
      async () =>
        (await docker("inspect", "--format", "{{.State.Health.Status}}", second.name)) ===
        "healthy",
      90_000
    );
    await touch.context.close();
  });
  await caseRun("same image serves a nested runtime mount", async () => {
    const nested = await start("nested", await volume("nested"), 3000, [
      "-e",
      "BASE_PATH=/family/planner",
    ]);
    await healthy(nested);
    assert.equal((await fetch(`${nested.base}/api/settings`)).status, 404);
    const mounted = { ...nested, base: `${nested.base}/family/planner` };
    const session = await provision(mounted, "nested", { width: 1280, height: 900 });
    await session.page.goto(`${mounted.base}?bookmark=1`);
    await expect(session.page).toHaveURL(`${mounted.base}/?bookmark=1`);
    await expect(session.page.getByTestId("home-surface")).toBeVisible();
    await session.page.goto(`${mounted.base}/calendar`);
    await expect(session.page.getByTestId("calendar-period-title")).toBeVisible();
    await session.page.reload();
    await expect(session.page.getByTestId("calendar-period-title")).toBeVisible();
    for (const cookie of await session.context.cookies()) {
      if (["mp_gate", "mp_device_key", "mp_provisioned"].includes(cookie.name))
        assert.equal(cookie.path, "/family/planner/");
    }
    await session.context.close();
  });
  await caseRun("missing credentials remain locked", async () => {
    const locked = await start("locked", await volume("locked"), 3000, [], false);
    await healthy(locked);
    assert.equal((await fetch(`${locked.base}/api/members`)).status, 401);
    const page = await browser.newPage();
    await page.goto(locked.base);
    await expect(page.getByTestId("access-gate-form")).toBeVisible();
    await page.locator('input[name="token"]').fill(token);
    await page.getByRole("button", { name: "Enter", exact: true }).click();
    await expect(page.getByTestId("access-gate-form")).toBeVisible();
    await expect(page.getByRole("button", { name: "Provision Device" })).toHaveCount(0);
    await page.close();
  });
  await caseRun("native renderer, fonts and private material exclusion", async () => {
    await docker(
      "exec",
      primary.name,
      "node",
      "--input-type=module",
      "-e",
      `import fs from 'node:fs';import assert from 'node:assert/strict';import * as m from '/app/dist/daily-briefing-render/index.js';const font='/app/dist/server/fonts/jetbrains-mono';assert(fs.readdirSync(font).some(f=>f.endsWith('.ttf')));assert(fs.existsSync(font+'/OFL.txt'));const r=await m.renderBriefingBitmap({memberId:'container',memberName:'Container',date:'2026-10-02',blocks:[{type:'message',title:'MESSAGE',data:{text:'Container render'}}]});assert(r.bitmapPng);assert.equal(r.failedRenderBlocks.length,0);const p=m.pngToPackedRaster(r.bitmapPng);assert(p.bits.some(b=>b!==0));`
    );
    await docker(
      "exec",
      primary.name,
      "node",
      "-e",
      `const fs=require('fs'),assert=require('assert/strict');const forbidden=/^(?:\\.git|\\.worktrees|\\.agents|\\.codex|\\.data|\\.quality|backups|seed-private)$/;function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){assert(!forbidden.test(e.name), 'private path '+e.name);assert(!/^\\.env(?:$|\\.)/.test(e.name),'environment file');const f=p+'/'+e.name;if(e.isDirectory()){if(e.name!=='node_modules')walk(f)}else{assert(!/\\.(?:db|sqlite)(?:-wal|-shm)?$/.test(e.name),'database file');if(f.startsWith('/app/dist/client/')){const s=fs.readFileSync(f);for(const needle of [process.env.MP_ACCESS_TOKEN,process.env.MP_BOOTSTRAP_KEY,'VITE_DEV_BYPASS_ADMIN_PIN','__MP_TEST'])assert(!s.includes(needle),'client secret/test hook')}}}}walk('/app');`
    );
  });
  await caseRun("unwritable storage rejects startup", async () => {
    readonlyDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
    const rejected = await start("readonly", `${readonlyDir}:ro`);
    assert.notEqual(await docker("wait", rejected.name), "0");
    assert.match(
      await docker("logs", rejected.name),
      /readonly|read-only|EACCES|SQLITE_CANTOPEN|permission denied|EROFS/i
    );
  });
  await caseRun("SIGTERM drains both scheduler writes", async () => {
    const drainStore = await volume("drain");
    const drain = await start("drain", drainStore, 3000, [
      "-e",
      "SCHEDULER_DISABLED=0",
      "-e",
      "SCHEDULER_SMOKE_JOB=1",
      "-e",
      "SCHEDULER_SMOKE_SLOW_MS=2000",
      "-e",
      "SCHEDULER_SMOKE_WRITE_PATH=/data/smoke.txt",
    ]);
    await healthy(drain);
    await until(
      async () => (await docker("logs", drain.name)).includes("smoke job started"),
      75_000
    );
    assert(!(await docker("logs", drain.name)).includes("smoke job fired"));
    await docker("kill", "--signal", "TERM", drain.name);
    assert.equal(await docker("wait", drain.name), "0");
    const log = await docker("logs", drain.name);
    assert(log.indexOf("smoke job fired") < log.indexOf("scheduler drained"));
    await oneShot("drain-readback", [
      "-v",
      `${drainStore}:/data:ro`,
      "--entrypoint",
      "node",
      image,
      "-e",
      `const fs=require('fs'),assert=require('assert/strict');assert.equal(fs.readFileSync('/data/smoke.txt','utf8'),'smoke job write complete\\n');assert.equal(fs.readFileSync('/data/smoke.txt.second','utf8'),'smoke job second write complete\\n')`,
    ]);
  });
} catch (error) {
  failed = true;
  metadata.error = redact(error.stack);
  console.error(redact(error.message));
} finally {
  await browser?.close().catch(() => {
    failed = true;
  });
  const cleanupErrors = [];
  for (const name of containers) {
    cleanupErrors.push(
      ...(
        await cleanupContainer(
          name,
          async () => writeFile(join(evidence, `${name}.log`), redact(await docker("logs", name))),
          async () => docker("rm", "--force", name)
        )
      ).map(redact)
    );
  }
  for (const name of volumes) {
    try {
      await docker("volume", "rm", name);
    } catch (error) {
      cleanupErrors.push(redact(error.message));
    }
  }
  try {
    const remainingContainers = (await docker("ps", "-a", "--format", "{{.Names}}")).split("\n");
    const remainingVolumes = (await docker("volume", "ls", "--format", "{{.Name}}")).split("\n");
    assert(
      !containers.some((name) => remainingContainers.includes(name)),
      "owned container leaked"
    );
    assert(!volumes.some((name) => remainingVolumes.includes(name)), "owned volume leaked");
  } catch (error) {
    cleanupErrors.push(redact(error.message));
  }
  if (readonlyDir) await rm(readonlyDir, { recursive: true, force: true });
  results.push({
    name: "owned resource cleanup",
    status: cleanupErrors.length ? "failed" : "passed",
    errors: cleanupErrors,
  });
  failed ||= cleanupErrors.length > 0;
  metadata.status = failed ? "failed" : "passed";
  await writeFile(join(evidence, "results.json"), JSON.stringify(metadata, null, 2) + "\n");
}
process.exitCode = failed ? 1 : 0;
