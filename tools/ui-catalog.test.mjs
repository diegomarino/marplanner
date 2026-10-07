import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "prettier";
import { renderCatalog } from "./dev/generate-ui-catalog.mjs";

test("UI catalog matches the real shared exports and detects a new export", async () => {
  assert.equal(
    readFileSync("COMPONENTS.md", "utf8"),
    await format(renderCatalog(), { parser: "markdown" })
  );
  const root = mkdtempSync(join(tmpdir(), "ui-catalog-"));
  try {
    mkdirSync(join(root, "src/client/components/ui"), { recursive: true });
    writeFileSync(join(root, "src/client/ui.ts"), 'export * from "./components/ui/button";');
    const source = join(root, "src/client/components/ui/button.tsx");
    writeFileSync(source, "function Button() {} export { Button };");
    const before = renderCatalog(root);
    assert.match(before, /`Button`/);
    writeFileSync(
      source,
      "function Button() {} function NewControl() {} export { Button, NewControl };"
    );
    assert.notEqual(renderCatalog(root), before);
    assert.match(renderCatalog(root), /`NewControl`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
