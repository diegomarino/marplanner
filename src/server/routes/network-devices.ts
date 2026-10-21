import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import { requireCapability } from "../auth/capability";
import { networkDevicesSchemas } from "../openapi/network-devices";
import { documented, type RouteSchema } from "../openapi/zod";
import { MemberReferenceError } from "../modules/members/referential";
import {
  register,
  edit,
  remove,
  exists,
  block,
  unblock,
  list,
  getLiveClientsSnapshot,
  NetworkDeviceValidationError,
  NetworkDeviceNotFoundError,
  NetworkDeviceDuplicateError,
  NetworkDeviceReselectRequiredError,
  NetworkDeviceControllerUnavailableError,
  NetworkDeviceControllerRejectedError,
  NetworkDeviceControllerUnreachableError,
} from "../modules/network-devices/index";
import type { EditDeviceInput } from "../modules/network-devices/index";

/** Whole-domain HTTP surface — src/server/openapi/network-devices.ts (docs/api/openapi.json).
 * EVERY route declares `requireCapability('network:admin')` — registered fail-closed via
 * `registerNetworkDeviceRoutes` below. A provisioned device `*` cookie satisfies it like every
 * other household-tier admin endpoint (ADR-058, single household tier; owner decision
 * 2026-10-15 superseding the ADR-053 device-key carve-out). The Admin PIN is a UI-only gate
 * and is never evaluated here (FR-002).
 * Error mapping (module error classes -> HTTP): `NetworkDeviceValidationError`/
 * `MemberReferenceError` -> 400; `NetworkDeviceNotFoundError` -> 404;
 * `NetworkDeviceDuplicateError`/`NetworkDeviceReselectRequiredError` -> 409 `{error, code}`;
 * `NetworkDeviceControllerUnavailableError`/`ControllerRejectedError`/`ControllerUnreachableError`
 * -> 502 `{error, code}` (the 502 branch was previously omitting `err.code`,
 * forcing the client to pattern-match on `.message` text to distinguish the three controller
 * states — now every one of these five error classes carries its own `code`, so `{error, code}`
 * is the uniform machine-readable shape across every non-400/404 error this domain returns).
 * Every error body is `{error}` or `{error, code}` only — no extra keys (contract `ErrorResponse`
 * is `additionalProperties: false`), and every `.message` on these classes is already MAC-free
 * (FR-013/INV-07 — see each class's own docblock in `index.ts`).
 * DELETE needs its OWN existence read (`index.ts`'s `remove` doc comment: "a DELETE endpoint
 * that wants to answer 404-vs-200 needs its OWN existence read before calling this function —
 * `remove` itself is intentionally idempotent") — done here via the module's own `exists`
 * export, keeping the `network_devices` schema a module-owned detail rather than a raw SELECT
 * reappearing at this (core, non-Rule-B-fenced) route layer.
 */

const NETWORK_DEVICES_CAPABILITY = "network:admin";

interface NetworkDeviceRouteSpec {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  schema: RouteSchema;
  handler: RouteHandlerMethod;
}

function registerNetworkDeviceRoutes(app: FastifyInstance, routes: NetworkDeviceRouteSpec[]): void {
  const preHandler = [requireCapability(NETWORK_DEVICES_CAPABILITY)];
  for (const route of routes) {
    app[route.method](route.path, { preHandler, ...documented(route.schema) }, route.handler);
  }
}

function sendError(reply: FastifyReply, status: number, error: string, code?: string) {
  return reply.code(status).send(code ? { error, code } : { error });
}

/** Maps every `modules/network-devices` error class to its contract HTTP status. Anything else
 * is an unexpected fault — logged, answered 500 (no schema governs 500; not part of the
 * contract for any of these routes). */
function mapNetworkDeviceError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof NetworkDeviceDuplicateError) {
    return sendError(reply, 409, err.message, err.code);
  }
  if (err instanceof NetworkDeviceReselectRequiredError) {
    return sendError(reply, 409, err.message, err.code);
  }
  if (err instanceof NetworkDeviceNotFoundError) {
    return sendError(reply, 404, err.message);
  }
  if (err instanceof NetworkDeviceValidationError || err instanceof MemberReferenceError) {
    return sendError(reply, 400, err.message);
  }
  if (
    err instanceof NetworkDeviceControllerUnavailableError ||
    err instanceof NetworkDeviceControllerRejectedError ||
    err instanceof NetworkDeviceControllerUnreachableError
  ) {
    return sendError(reply, 502, err.message, err.code);
  }
  console.error("Unexpected error in network-devices handler:", err);
  return reply.code(500).send({ error: "internal_error" });
}

const REGISTER_ALLOWED_KEYS = new Set(["mac", "alias", "memberId"]);
const EDIT_ALLOWED_KEYS = new Set(["alias", "memberId"]);

function isPlainObjectBody(body: unknown): body is Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body);
}

export async function networkDevicesRoutes(app: FastifyInstance): Promise<void> {
  registerNetworkDeviceRoutes(app, [
    {
      // GET /api/network-devices — the curated registry with derived live status (ZERO
      // writes, INV-05).
      method: "get",
      path: "/api/network-devices",
      schema: networkDevicesSchemas.getNetworkDevices,
      handler: async (_request: FastifyRequest, reply: FastifyReply) => {
        const result = list(Date.now());
        return reply.code(200).send(result);
      },
    },
    {
      // GET /api/network-devices/live-clients — the picker feed.
      method: "get",
      path: "/api/network-devices/live-clients",
      schema: networkDevicesSchemas.getNetworkDevicesLiveClients,
      handler: async (_request: FastifyRequest, reply: FastifyReply) => {
        const result = getLiveClientsSnapshot();
        return reply.code(200).send(result);
      },
    },
    {
      // POST /api/network-devices — register a device from the fresh picker cache.
      method: "post",
      path: "/api/network-devices",
      schema: networkDevicesSchemas.postNetworkDevices,
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body;
        if (!isPlainObjectBody(body)) {
          return sendError(reply, 400, "Request body must be an object");
        }
        const unknownKeys = Object.keys(body).filter((key) => !REGISTER_ALLOWED_KEYS.has(key));
        if (unknownKeys.length > 0) {
          return sendError(
            reply,
            400,
            `Unsupported field(s) in register device body: ${unknownKeys.join(", ")}`
          );
        }
        const memberIdRaw = body.memberId;
        if (memberIdRaw !== undefined && memberIdRaw !== null && typeof memberIdRaw !== "string") {
          return sendError(reply, 400, "memberId must be a string or null");
        }
        try {
          const device = register(body.mac, body.alias, memberIdRaw as string | null | undefined);
          return reply.code(201).send(device);
        } catch (err) {
          return mapNetworkDeviceError(err, reply);
        }
      },
    },
    {
      // PATCH /api/network-devices/:id — edit alias/assignment (local-only; MAC immutable).
      method: "patch",
      path: "/api/network-devices/:id",
      schema: networkDevicesSchemas.patchNetworkDevicesById,
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const body = request.body;
        if (!isPlainObjectBody(body)) {
          return sendError(reply, 400, "Request body must be an object");
        }
        const unknownKeys = Object.keys(body).filter((key) => !EDIT_ALLOWED_KEYS.has(key));
        if (unknownKeys.length > 0) {
          return sendError(
            reply,
            400,
            `Unsupported field(s) in edit device body: ${unknownKeys.join(", ")}`
          );
        }
        if (body.alias !== undefined && typeof body.alias !== "string") {
          return sendError(reply, 400, "alias must be a string");
        }
        if (
          body.memberId !== undefined &&
          body.memberId !== null &&
          typeof body.memberId !== "string"
        ) {
          return sendError(reply, 400, "memberId must be a string or null");
        }

        const input: EditDeviceInput = {};
        if (body.alias !== undefined) input.alias = body.alias as string;
        if (body.memberId !== undefined) input.memberId = body.memberId as string | null;

        try {
          const device = edit(id, input);
          return reply.code(200).send(device);
        } catch (err) {
          return mapNetworkDeviceError(err, reply);
        }
      },
    },
    {
      // DELETE /api/network-devices/:id — local-only, NO controller call ever (AC-04). Own
      // existence read: `remove` is an idempotent no-op and reports no 404-vs-204 distinction
      // on its own (see index.ts's `remove` docblock, ROUTE-LAYER NOTE).
      method: "delete",
      path: "/api/network-devices/:id",
      schema: networkDevicesSchemas.deleteNetworkDevicesById,
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        if (!exists(id)) {
          return sendError(reply, 404, `Network device not found: ${id}`);
        }
        remove(id);
        return reply.code(204).send();
      },
    },
    {
      // POST /api/network-devices/:id/block — intent -> controller (authoritative) -> mirror.
      method: "post",
      path: "/api/network-devices/:id/block",
      schema: networkDevicesSchemas.postNetworkDevicesByIdBlock,
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        try {
          const device = await block(id);
          return reply.code(200).send(device);
        } catch (err) {
          return mapNetworkDeviceError(err, reply);
        }
      },
    },
    {
      // POST /api/network-devices/:id/unblock — symmetric to block.
      method: "post",
      path: "/api/network-devices/:id/unblock",
      schema: networkDevicesSchemas.postNetworkDevicesByIdUnblock,
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        try {
          const device = await unblock(id);
          return reply.code(200).send(device);
        } catch (err) {
          return mapNetworkDeviceError(err, reply);
        }
      },
    },
  ]);
}
