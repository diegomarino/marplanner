import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("local server and seed scripts load the optional local environment", () => {
  assert.equal(
    packageJson.scripts["dev:server"],
    "node --env-file-if-exists=.env.local --import tsx --watch src/server/index.ts"
  );
  assert.equal(
    packageJson.scripts.start,
    "node --env-file-if-exists=.env.local dist/server/index.js"
  );
  assert.equal(
    packageJson.scripts.seed,
    "node --env-file-if-exists=.env.local --import tsx src/server/db/seeds/cli.ts --mode public"
  );
  assert.equal(
    packageJson.scripts["seed:private"],
    "node --env-file-if-exists=.env.local --import tsx src/server/db/seeds/cli.ts --mode private"
  );
});

test("the committed example documents credentials and defaults the local UI bypass off", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const keys = example
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.slice(0, line.indexOf("=")));

  assert.match(example, /^VITE_DEV_BYPASS_ADMIN_PIN=0$/m);
  assert.deepEqual(keys, [
    "MP_ACCESS_TOKEN",
    "MP_BOOTSTRAP_KEY",
    "MP_MANAGEMENT_KEY",
    "ADMIN_PIN",
    "VITE_DEV_BYPASS_ADMIN_PIN",
  ]);
});

test("the populated local environment remains gitignored", () => {
  const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /^\.env\.local$/m);
});
