import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireFullAccess } from "../auth/capability";
import {
  configuredBootstrapId,
  DeviceCredentialError,
  labelCredential,
  listCredentials,
  revokeCredential,
  type CredentialSummary,
} from "../auth/devices";
import { getDb } from "../db/client";
import { deviceCredentialsSchemas } from "../openapi/device-credentials";
import { documented } from "../openapi/zod";
import type { DeviceCredential, DeviceCredentialErrorCode } from "../../shared";

/** Admin HTTP surface over the operator credential logic the `npm run devices` CLI also uses
 * (src/server/auth/devices.ts), so a hosted deploy can retire a lost device without a shell.
 * `requireFullAccess`: a provisioned `*` device cookie; bootstrap keys never reach these routes.
 * The Admin PIN gates the page only and is never evaluated here (FR-002). No response carries a
 * raw key or a key hash. Revocation takes effect on the credential's next request, because the
 * boundary reads `revoked_at` per request; revoking the caller's own credential is allowed. */

type AuthenticatedRequest = FastifyRequest & { apiKeyId?: string };

/** The server's own MP_BOOTSTRAP_KEY. Unlike the CLI, the server always knows it, so an unset
 * variable means "no bootstrap key is configured", never "unknown". */
function configuredBootstrap(): string {
  return process.env.MP_BOOTSTRAP_KEY ?? "";
}

function present(
  summary: CredentialSummary,
  currentId: string | undefined,
  bootstrapId: string | null
): DeviceCredential {
  return {
    id: summary.id,
    kind: summary.kind as DeviceCredential["kind"],
    label: summary.label,
    createdAt: summary.createdAt,
    expiresAt: summary.expiresAt,
    state: summary.state,
    current: summary.id === currentId,
    configuredBootstrap: summary.id === bootstrapId,
  };
}

function snapshot(request: AuthenticatedRequest): DeviceCredential[] {
  const db = getDb();
  const bootstrapId = configuredBootstrapId(db, configuredBootstrap());
  return listCredentials(db, Date.now()).map((summary) =>
    present(summary, request.apiKeyId, bootstrapId)
  );
}

function findOne(request: AuthenticatedRequest, id: string): DeviceCredential {
  const found = snapshot(request).find((credential) => credential.id === id);
  if (!found)
    throw new DeviceCredentialError(`No credential with id ${id}`, "credential_not_found");
  return found;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: DeviceCredentialErrorCode,
  message: string
) {
  return reply.code(status).send({ code, message });
}

function mapError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof DeviceCredentialError)) throw error;
  if (error.code === "credential_not_found") {
    return sendError(reply, 404, error.code, error.message);
  }
  if (error.code === "invalid_label") return sendError(reply, 400, error.code, error.message);
  // `bootstrap_unknown` cannot happen here (the server always passes its own value), so every
  // remaining refusal is the configured bootstrap key.
  return sendError(reply, 409, "configured_bootstrap", error.message);
}

export async function deviceCredentialsRoutes(app: FastifyInstance): Promise<void> {
  const preHandler = requireFullAccess();

  app.get(
    "/api/auth/credentials",
    { preHandler, ...documented(deviceCredentialsSchemas.listDeviceCredentials) },
    async (request, reply) => reply.code(200).send({ credentials: snapshot(request) })
  );

  app.patch(
    "/api/auth/credentials/:id",
    { preHandler, ...documented(deviceCredentialsSchemas.labelDeviceCredential) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body;
      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).join() !== "label" ||
        typeof (body as { label: unknown }).label !== "string"
      ) {
        return sendError(reply, 400, "invalid_label", "The body must be exactly {label: string}");
      }
      try {
        labelCredential(getDb(), id, (body as { label: string }).label);
        return reply.code(200).send(findOne(request, id));
      } catch (error) {
        return mapError(error, reply);
      }
    }
  );

  app.post(
    "/api/auth/credentials/:id/revoke",
    { preHandler, ...documented(deviceCredentialsSchemas.revokeDeviceCredential) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const revoked = revokeCredential(getDb(), id, Date.now(), configuredBootstrap());
        return reply.code(200).send({ credential: findOne(request, id), revoked });
      } catch (error) {
        return mapError(error, reply);
      }
    }
  );
}
