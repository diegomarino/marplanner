import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("calendar external-source public contract", () => {
  it("documents a masked response DTO and a route-level domain seam without exposing feedUrl", () => {
    const contract = readFileSync("docs/api/calendar/openapi.yaml", "utf8");
    const shared = readFileSync("src/shared/index.ts", "utf8");

    expect(contract).toContain("/api/calendar/external-sources:");
    expect(contract).toContain("ExternalSourcePublic:");
    expect(contract).toContain("maskedUrl:");
    expect(contract).not.toMatch(/ExternalSourcePublic:[\\s\\S]*?feedUrl:/);
    expect(shared).toContain("export interface ExternalSourcePublic");
    expect(shared).toContain("maskedUrl: string;");
  });
});
