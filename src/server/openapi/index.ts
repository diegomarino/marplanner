import type { FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifyApiReference from "@scalar/fastify-api-reference";
import { z } from "zod";
import { API_INFO, API_TAGS, SECURITY_SCHEMES } from "./document";
import { docsSchemas } from "./docs";
import { componentIds, documented, type RouteResponse } from "./zod";

/** Code-first OpenAPI.
 *
 * Every API route declares a `schema` built from zod (src/server/openapi/<domain>.ts).
 * `@fastify/swagger` collects those route schemas and this module converts the zod schemas to
 * JSON Schema 2020-12 (OpenAPI 3.1) with zod's own `toJSONSchema`; named schemas registered
 * through `component()` become `#/components/schemas/<id>` references.
 *
 * The schemas are DOCUMENTATION-ONLY at runtime: the validator compiler accepts every input and
 * the serializer compiler is plain `JSON.stringify`, so status codes, `{ error, message }`
 * envelopes, messages, coercion and check order stay exactly as implemented by the
 * hand-written validation in src/server/modules/*. Response schemas never strip fields.
 */

export const OPENAPI_DOCUMENT_PATH = "/api/openapi.json";
export const API_REFERENCE_PATH = "/api/docs";

const REF_PREFIX = "#/components/schemas/";
const ROUTE_SCHEMA_ID = "__mp_route_schema__";
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isZod = (value: unknown): value is z.ZodType => value instanceof z.ZodType;

function toJsonSchemaOptions(io: "input" | "output") {
  return {
    target: "draft-2020-12" as const,
    io,
    unrepresentable: "any" as const,
    cycles: "ref" as const,
    reused: "inline" as const,
    uri: (id: string) => `${REF_PREFIX}${id}`,
  };
}

/** zod stamps `$schema`/`$id` on each root; references go through `#/components/schemas/`. */
function withoutIdentity(schema: JsonObject): JsonObject {
  const out = { ...schema };
  delete out.$schema;
  delete out.$id;
  return out;
}

/** Convert one route-level zod schema; registered components become `$ref`s. */
export function zodToJsonSchema(schema: z.ZodType, io: "input" | "output"): JsonObject {
  const id = z.globalRegistry.get(schema)?.id;
  if (typeof id === "string" && componentIds.has(id)) return { $ref: `${REF_PREFIX}${id}` };
  const registry = z.registry<{ id: string }>();
  registry.add(schema, { id: ROUTE_SCHEMA_ID });
  const { schemas } = z.toJSONSchema(registry, {
    ...toJsonSchemaOptions(io),
    metadata: z.globalRegistry,
  });
  const json = withoutIdentity(schemas[ROUTE_SCHEMA_ID] as JsonObject);
  // Components outside the temporary registry are emitted as `<uri>#/$defs/<id>`.
  return JSON.parse(JSON.stringify(json), (key, value: Json) => {
    if (key !== "$ref" || typeof value !== "string") return value;
    const match = /#\/\$defs\/(.+)$/.exec(value);
    if (!match) return value;
    if (!componentIds.has(match[1])) throw new Error(`Unregistered shared schema ${match[1]}`);
    return `${REF_PREFIX}${match[1]}`;
  }) as JsonObject;
}

/** Every schema registered with `component()`, keyed by component id. */
export function componentSchemas(): Record<string, JsonObject> {
  const { schemas } = z.toJSONSchema(z.globalRegistry, toJsonSchemaOptions("output"));
  const out: Record<string, JsonObject> = {};
  for (const id of [...componentIds].sort()) {
    out[id] = withoutIdentity(schemas[id] as JsonObject);
  }
  return out;
}

function mapValues<T, U>(record: Record<string, T>, fn: (value: T) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]));
}

function convertResponse(definition: RouteResponse): JsonObject {
  if (isZod(definition)) return zodToJsonSchema(definition, "output");
  const out: JsonObject = { description: definition.description };
  if (definition.headers)
    out.headers = mapValues(definition.headers, (header) => zodToJsonSchema(header, "output"));
  out.content = mapValues(definition.content, ({ schema }) => ({
    schema: zodToJsonSchema(schema, "output"),
  }));
  return out;
}

/** Only `/health` and `/api/*` belong to the HTTP contract; the SPA shell, static assets and the
 * access gate are hidden, as are routes that opt out (`schema.hide`, e.g. the reference UI). */
function isApiUrl(url: string, basePath: string): boolean {
  const path = basePath && url.startsWith(basePath) ? url.slice(basePath.length) : url;
  return path === "/health" || path.startsWith("/api/");
}

type SwaggerTransformInput = { schema?: Record<string, unknown>; url: string };

export function createRouteTransform(basePath: string) {
  return ({ schema, url }: SwaggerTransformInput) => {
    if (!isApiUrl(url, basePath)) return { schema: { hide: true }, url };
    if (!schema || schema.hide) return { schema: schema ?? {}, url };
    const out: Record<string, unknown> = { ...schema };
    for (const key of ["params", "querystring", "headers", "body"] as const) {
      const value = schema[key];
      if (isZod(value)) out[key] = zodToJsonSchema(value, "input");
    }
    const response = schema.response as Record<string, RouteResponse> | undefined;
    if (response) out.response = mapValues(response, convertResponse);
    return { schema: out, url };
  };
}

// ---------------------------------------------------------------- document post-processing

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Remove zod artefacts that carry no meaning in the published contract. */
function tidy(value: Json): Json {
  if (Array.isArray(value)) return value.map(tidy);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) out[key] = tidy(child);
  // z.int() carries the safe-integer range; the contracts never stated it.
  if (out.minimum === -MAX_SAFE) delete out.minimum;
  if (out.maximum === MAX_SAFE) delete out.maximum;
  // Loose objects say "additional properties allowed", which is the JSON Schema default.
  if (isObject(out.additionalProperties) && !Object.keys(out.additionalProperties).length)
    delete out.additionalProperties;
  if (isObject(out.propertyNames) && out.propertyNames.type === "string") {
    if (Object.keys(out.propertyNames).length === 1) delete out.propertyNames;
  }
  if (out.type === "object" && isObject(out.properties) && !Object.keys(out.properties).length)
    delete out.properties;
  return out;
}

const sortKeys = (record: JsonObject): JsonObject =>
  Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]])
  );

/** Final, deterministic OpenAPI document. Exported for `tools/generate-openapi.mjs`. */
export function finalizeDocument(document: JsonObject): JsonObject {
  const doc = tidy(document) as JsonObject;
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const item of Object.values(paths)) {
    if (!isObject(item)) continue;
    for (const operation of Object.values(item)) {
      if (!isObject(operation)) continue;
      if (operation["x-mp-body-optional"] === true && isObject(operation.requestBody))
        operation.requestBody.required = false;
      delete operation["x-mp-body-optional"];
      const responses = isObject(operation.responses) ? operation.responses : {};
      for (const response of Object.values(responses)) {
        if (!isObject(response) || !isObject(response.headers)) continue;
        for (const header of Object.values(response.headers)) {
          if (!isObject(header) || !isObject(header.schema)) continue;
          if (header.schema["x-mp-required"] === true) header.required = true;
          delete header.schema["x-mp-required"];
        }
      }
    }
  }
  doc.paths = sortKeys(paths);
  const components = isObject(doc.components) ? doc.components : {};
  if (isObject(components.schemas)) components.schemas = sortKeys(components.schemas);
  return doc;
}

// ---------------------------------------------------------------- registration

/** Register the OpenAPI collector. Must run before any route is added, because
 * `@fastify/swagger` records routes from its `onRoute` hook. Validation/serialization stay
 * documentation-only through the per-route compilers installed by `documented()`. */
export async function registerOpenApi(app: FastifyInstance, basePath: string): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: API_INFO,
      servers: [{ url: basePath || "/" }],
      tags: API_TAGS,
      components: { securitySchemes: SECURITY_SCHEMES as never },
    },
    transform: createRouteTransform(basePath) as never,
    transformObject: (input) => {
      const document = (input as { openapiObject: unknown }).openapiObject as JsonObject;
      const components = isObject(document.components) ? document.components : {};
      return finalizeDocument({
        ...document,
        components: { ...components, schemas: componentSchemas() },
      }) as never;
    },
  });
}

/** `GET /api/openapi.json` and the reference UI under `/api/docs`. Both live under `/api/*`,
 * so the API-key boundary (src/server/auth/boundary.ts) protects them like every other route. */
export async function openApiDocsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    OPENAPI_DOCUMENT_PATH,
    documented(docsSchemas.getOpenApiDocument),
    async (_request, reply) => reply.type("application/json; charset=utf-8").send(app.swagger())
  );
  await app.register(fastifyApiReference, {
    routePrefix: API_REFERENCE_PATH,
    configuration: {
      // Relative to `/api/docs/`, so it also resolves under a BASE_PATH prefix.
      url: "../openapi.json",
      pageTitle: "Marplanner API reference",
      withDefaultFonts: false,
      hideClientButton: true,
      // Self-hosted household API: no hosted Scalar extras (AI agent, MCP generator,
      // developer toolbar) and no telemetry calls out of the instance.
      agent: { disabled: true },
      mcp: { disabled: true },
      showDeveloperTools: "never",
      telemetry: false,
    },
  });
}
