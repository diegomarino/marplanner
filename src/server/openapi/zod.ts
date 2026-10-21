import type {} from "@fastify/swagger";
import { z } from "zod";

/** A documented response: either a bare zod schema (JSON body) or an OpenAPI-style
 * object carrying a description, optional response headers and per-media-type bodies. */
export type RouteResponse =
  | z.ZodType
  | {
      description: string;
      headers?: Record<string, z.ZodType>;
      content: Record<string, { schema: z.ZodType }>;
    };

/** The `schema` object every documented route declares. Fastify receives it unchanged;
 * `registerOpenApi` installs validator/serializer compilers that keep it documentation-only. */
export interface RouteSchema {
  operationId: string;
  tags: string[];
  summary?: string;
  description?: string;
  security?: Array<Record<string, string[]>>;
  params?: z.ZodType;
  querystring?: z.ZodType;
  headers?: z.ZodType;
  body?: z.ZodType;
  consumes?: string[];
  /** The request body may be omitted entirely (OpenAPI `requestBody.required: false`). */
  "x-mp-body-optional"?: boolean;
  response: Record<number, RouteResponse>;
}

/** Ids registered through `component()`; these, and only these, become OpenAPI components. */
export const componentIds = new Set<string>();

/** Register a named schema as an OpenAPI component (`#/components/schemas/<id>`).
 * Re-evaluating a module (Vitest module isolation, `vi.resetModules`) re-registers the id
 * instead of throwing on the duplicate. */
export function component<T extends z.ZodType>(
  id: string,
  schema: T,
  meta?: Record<string, unknown>
): T {
  const existing = z.globalRegistry._idmap.get(id);
  if (existing) z.globalRegistry.remove(existing);
  // Keep metadata already attached to this exact instance (e.g. a `.meta()` call on it).
  z.globalRegistry.add(schema as z.ZodType, { ...z.globalRegistry.get(schema), ...meta, id });
  componentIds.add(id);
  return schema;
}

/** A response documented by its description only (no body, or a body we do not describe). */
export function noContent(description: string): z.ZodNull {
  return z.null().describe(description);
}

const acceptAnyInput = () => () => true;
/** Fastify's error path hands the serializer `Object.create(error, { error, message, statusCode })`,
 * whose properties are non-enumerable, so plain `JSON.stringify` would send `{}`. Errors get the
 * envelope Fastify's schemaless error serializer emits, in its key order; `code` drops out when
 * undefined, as it does there. */
const serializeAsIs = () => (data: unknown) => {
  if (!(data instanceof Error)) return JSON.stringify(data);
  const error = data as Error & { statusCode?: number; code?: string; error?: string };
  return JSON.stringify({
    statusCode: error.statusCode,
    code: error.code,
    error: error.error,
    message: error.message,
  });
};

/** Route options for a documented route: the zod `schema` plus per-route compilers that keep it
 * DOCUMENTATION-ONLY. The validator accepts every request unchanged (no coercion, defaults or
 * stripping), and the serializer is plain `JSON.stringify` — byte-identical to Fastify's output
 * for a schemaless route — so the hand-written checks in src/server/modules/* keep owning status
 * codes, `{ error, message }` envelopes and messages. Per-route compilers (rather than
 * instance-level ones) also hold when a route module is mounted on a bare Fastify instance. */
export function documented(schema: RouteSchema) {
  return { schema, validatorCompiler: acceptAnyInput, serializerCompiler: serializeAsIs };
}

/** Declare a domain's route schemas. Keys stay checked (`domainSchemas.unknownKey` is a type
 * error) while each value is widened to `RouteSchema`, so Fastify does not narrow
 * `reply.code()` to the documented status codes — handlers keep their existing behaviour. */
export function defineRouteSchemas<T extends Record<string, RouteSchema>>(
  schemas: T
): { readonly [K in keyof T]: RouteSchema } {
  return schemas;
}
