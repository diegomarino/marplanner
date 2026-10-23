import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const CORPORA = "src/server/modules/daily-briefing/corpora";

/** Corpus files the shipped NOTICE.txt gives an entry (a heading line naming the file). */
function noticedCorpora() {
  return readFileSync(`${CORPORA}/NOTICE.txt`, "utf8")
    .split("\n")
    .filter((line) => /^\S+\.json$/.test(line));
}

test("the corpora notice covers the Spanish translation of every third-party corpus", () => {
  const noticed = noticedCorpora();
  for (const file of noticed) {
    const translation = file.replace(/(?<!\.es)\.json$/, ".es.json");
    if (translation !== file && existsSync(`${CORPORA}/${translation}`)) {
      assert.ok(noticed.includes(translation), `${translation} translates ${file}`);
    }
  }
});

test("THIRD_PARTY_NOTICES.md mirrors every corpus the shipped notice names", () => {
  const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
  for (const file of noticedCorpora()) assert.ok(notices.includes(`\`${file}\``), file);
});
