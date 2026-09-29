import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ExternalSourceErrorCode,
  ExternalSourcePublic,
  HighlightRule,
  HighlightRuleCreate,
  HighlightRuleOrder,
  HighlightRulePatch,
  SynchronizationPhase,
} from "../../src/shared/index";

type Schema = {
  type?: string;
  enum?: string[];
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, unknown>;
};

const plannedPath = path.resolve(process.cwd(), "docs/api/calendar-feed-sync/openapi.planned.yaml");
const implementedPath = path.resolve(process.cwd(), "docs/api/calendar-feed-sync/openapi.yaml");
const document = loadYaml(readFileSync(plannedPath, "utf8")) as {
  components?: { schemas?: Record<string, Schema> };
};
const schemas = document.components?.schemas ?? {};

describe("calendar feed synchronization contract", () => {
  it("publishes the implemented OpenAPI contract with source and highlight routes", () => {
    expect(existsSync(implementedPath)).toBe(true);
    const implemented = loadYaml(readFileSync(implementedPath, "utf8")) as {
      paths?: Record<string, unknown>;
    };

    expect(Object.keys(implemented.paths ?? {})).toEqual([
      "/api/calendar/external-sources",
      "/api/calendar/external-sources/{id}",
      "/api/calendar/external-sources/{id}/sync",
      "/api/calendar/highlight-rules",
      "/api/calendar/highlight-rules/reorder",
      "/api/calendar/highlight-rules/{id}",
    ]);
  });

  it("defines exact safe error and synchronization phase vocabularies", () => {
    expect(schemas.ExternalSourceErrorCode?.enum).toEqual([
      "unsafe_url",
      "unavailable",
      "timeout",
      "too_large",
      "invalid_calendar",
      "parse_failed",
      "reconcile_failed",
    ]);
    expect(schemas.SynchronizationPhase?.enum).toEqual([
      "requesting",
      "downloading",
      "parsing",
      "reconciling",
      "succeeded",
      "failed",
    ]);

    expectTypeOf<ExternalSourceErrorCode>().toEqualTypeOf<
      | "unsafe_url"
      | "unavailable"
      | "timeout"
      | "too_large"
      | "invalid_calendar"
      | "parse_failed"
      | "reconcile_failed"
    >();
    expectTypeOf<SynchronizationPhase>().toEqualTypeOf<
      "requesting" | "downloading" | "parsing" | "reconciling" | "succeeded" | "failed"
    >();
  });

  it("exposes source health and configurable polling without raw URLs or validators", () => {
    const schema = schemas.ExternalSourcePublic;
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required).toEqual([
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
    ]);
    expect(Object.keys(schema?.properties ?? {})).not.toContain("feedUrl");
    expect(Object.keys(schema?.properties ?? {})).not.toContain("etag");
    expect(Object.keys(schema?.properties ?? {})).not.toContain("lastModified");
    expect(Object.keys(schema?.properties ?? {})).not.toContain("contentHash");
    expect(schema?.properties).toHaveProperty("pollIntervalMin");

    expectTypeOf<ExternalSourcePublic>().toEqualTypeOf<{
      id: string;
      name: string;
      provider: "google" | "microsoft" | "apple" | "ics_generic";
      maskedUrl: string;
      enabled: boolean;
      pollIntervalMin: number;
      phase: SynchronizationPhase | null;
      lastAttemptAt: number | null;
      lastSuccessAt: number | null;
      lastErrorCode: ExternalSourceErrorCode | null;
      consecutiveFailures: number;
      lastImportedCount: number;
      lastSkippedCount: number;
    }>();
  });

  it("keeps write-only feedUrl on input and defines closed highlight DTO schemas", () => {
    expect(Object.keys(schemas.ExternalSourcePut?.properties ?? {})).toContain("feedUrl");
    expect(Object.keys(schemas.ExternalSourcePut?.properties ?? {})).toContain("pollIntervalMin");
    for (const name of [
      "HighlightRuleCreate",
      "HighlightRulePatch",
      "HighlightRule",
      "HighlightRuleOrder",
    ]) {
      expect(schemas[name]?.type, name).toBe("object");
      expect(schemas[name]?.additionalProperties, name).toBe(false);
    }
    expect(schemas.HighlightRule?.required).toEqual([
      "id",
      "emoji",
      "keywords",
      "enabled",
      "priority",
    ]);

    expectTypeOf<HighlightRuleCreate>().toEqualTypeOf<{ emoji: string; keywords: string[] }>();
    expectTypeOf<HighlightRulePatch>().toEqualTypeOf<{ enabled: boolean }>();
    expectTypeOf<HighlightRule>().toEqualTypeOf<{
      id: string;
      emoji: string;
      keywords: string[];
      enabled: boolean;
      priority: number;
    }>();
    expectTypeOf<HighlightRuleOrder>().toEqualTypeOf<{ orderedIds: string[] }>();
  });
});
