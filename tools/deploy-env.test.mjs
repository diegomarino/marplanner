import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PUBLIC_DEFAULT_ACCESS_TOKEN,
  PUBLIC_DEFAULT_ADMIN_PINS,
  PUBLIC_DEFAULT_BOOTSTRAP_KEY,
} from "../src/shared/default-credentials.ts";
import { readFlyEnv, REQUIRED_FLY_KEYS, validateFlyEnv } from "./deploy/env.mjs";

const valid = {
  MP_ACCESS_TOKEN: "mpg-x9f2c1d7",
  MP_BOOTSTRAP_KEY: "mpk-y8e3b2a6",
  ADMIN_PIN: "8642",
};

function tempFile(name, text) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-env-"));
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

test("validateFlyEnv accepts a complete production env", () => {
  assert.deepEqual(validateFlyEnv(valid).errors, []);
});

test("validateFlyEnv names each missing or empty required key", () => {
  const { errors } = validateFlyEnv({ ADMIN_PIN: "" });
  assert.equal(errors.length, 3);
  for (const key of ["MP_ACCESS_TOKEN", "MP_BOOTSTRAP_KEY", "ADMIN_PIN"])
    assert.ok(
      errors.some((e) => e.includes(key)),
      key
    );
});

test("validateFlyEnv enforces credential prefixes", () => {
  const token = validateFlyEnv({ ...valid, MP_ACCESS_TOKEN: "abc" }).errors;
  assert.equal(token.length, 1);
  assert.match(token[0], /mpg-/);
  const key = validateFlyEnv({ ...valid, MP_BOOTSTRAP_KEY: "abc" }).errors;
  assert.equal(key.length, 1);
  assert.match(key[0], /mpk-/);
});

test("validateFlyEnv refuses the published default credentials", () => {
  const cases = [
    ["MP_ACCESS_TOKEN", PUBLIC_DEFAULT_ACCESS_TOKEN],
    ["MP_BOOTSTRAP_KEY", PUBLIC_DEFAULT_BOOTSTRAP_KEY],
    ...PUBLIC_DEFAULT_ADMIN_PINS.map((pin) => ["ADMIN_PIN", pin]),
  ];
  for (const [key, value] of cases) {
    const { errors } = validateFlyEnv({ ...valid, [key]: value });
    assert.equal(errors.length, 1, `${key}=${value}`);
    assert.match(errors[0], new RegExp(key));
    assert.match(errors[0], /public/);
  }
});

test("validation messages never contain secret values", () => {
  const env = { MP_ACCESS_TOKEN: "SENTINEL-ONE", MP_BOOTSTRAP_KEY: "SENTINEL-TWO", ADMIN_PIN: "" };
  const text = JSON.stringify(validateFlyEnv(env).errors);
  assert.ok(!text.includes("SENTINEL-ONE"));
  assert.ok(!text.includes("SENTINEL-TWO"));
});

test("readFlyEnv parses quotes, export prefixes, comments and CRLF like Node", () => {
  const path = tempFile(
    "prod.env",
    "export ADMIN_PIN=\"12 34\"\r\n# c\r\nMP_ACCESS_TOKEN='mpg-a#b'\r\n"
  );
  assert.deepEqual({ ...readFlyEnv(path) }, { ADMIN_PIN: "12 34", MP_ACCESS_TOKEN: "mpg-a#b" });
});

test("readFlyEnv explains how to create a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-env-"));
  assert.throws(() => readFlyEnv(join(dir, "missing.env")), /USING_FLYIO\.md/);
});

test("the Fly env file and smoke cache are gitignored", () => {
  const lines = readFileSync(new URL("../.gitignore", import.meta.url), "utf8").split("\n");
  assert.ok(lines.includes(".env.fly"));
  assert.ok(lines.includes("infra/fly/.smoke-device"));
});

test("the required Fly keys are the deployment credentials", () => {
  assert.deepEqual([...REQUIRED_FLY_KEYS], ["MP_ACCESS_TOKEN", "MP_BOOTSTRAP_KEY", "ADMIN_PIN"]);
});

test("validateFlyEnv requires a PIN the Admin keypad can enter", () => {
  for (const pin of ["12 34", "abcd", "123", "1234567", "12a4"]) {
    const { errors } = validateFlyEnv({ ...valid, ADMIN_PIN: pin });
    assert.equal(errors.length, 1, pin);
    assert.match(errors[0], /ADMIN_PIN must be 4–6 digits/);
    assert.ok(!errors[0].includes(pin), pin);
  }
  for (const pin of ["8642", "86420", "864209"])
    assert.deepEqual(validateFlyEnv({ ...valid, ADMIN_PIN: pin }).errors, [], pin);
});
