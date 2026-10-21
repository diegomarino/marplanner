import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadGeneratedContract } from "../helpers/openapi-contract";

describe("calendar external-source public contract", () => {
  it("documents a masked response DTO and a route-level domain seam without exposing feedUrl", () => {
    const document = loadGeneratedContract();
    const shared = readFileSync("src/shared/index.ts", "utf8");

    expect(document.paths).toHaveProperty(["/api/calendar/external-sources"]);
    expect(document.components.schemas).toHaveProperty("ExternalSourcePublic");
    const schema = document.components.schemas.ExternalSourcePublic as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    const fields = [
      "id",
      "name",
      "provider",
      "maskedUrl",
      "enabled",
      "pollIntervalMin",
      "phase",
      "lastAttemptAt",
      "lastSuccessAt",
      "lastErrorCode",
      "consecutiveFailures",
      "lastImportedCount",
      "lastSkippedCount",
    ];
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual([...fields].sort());
    expect(Object.keys(schema.properties).sort()).toEqual([...fields].sort());
    for (const forbidden of ["feedUrl", "etag", "lastModified", "contentHash"]) {
      expect(schema.properties).not.toHaveProperty(forbidden);
    }
    expect(shared).toContain("export interface ExternalSourcePublic");
    expect(shared).toContain("maskedUrl: string;");
  });
});
