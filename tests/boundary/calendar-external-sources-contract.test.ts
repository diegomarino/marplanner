import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

describe("calendar external-source public contract", () => {
  it("documents a masked response DTO and a route-level domain seam without exposing feedUrl", () => {
    const contract = readFileSync("docs/api/calendar/openapi.yaml", "utf8");
    const shared = readFileSync("src/shared/index.ts", "utf8");

    expect(contract).toContain("/api/calendar/external-sources:");
    expect(contract).toContain("ExternalSourcePublic:");
    expect(contract).toContain("maskedUrl:");
    const document = loadYaml(contract) as {
      components: {
        schemas: {
          ExternalSourcePublic: {
            type: string;
            additionalProperties: boolean;
            required: string[];
            properties: Record<string, unknown>;
          };
        };
      };
    };
    const schema = document.components.schemas.ExternalSourcePublic;
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
