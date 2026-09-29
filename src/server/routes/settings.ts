import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface SettingsRouteDependencies {
  readEffectiveSettings: () => unknown;
  writeSettingsObject: (objectName: unknown, settings: unknown) => unknown;
  isValidationError: (error: unknown) => boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENVELOPE_KEYS = new Set(["object", "settings"]);

/** HTTP adapter only: validation and persistence are owned by the Settings domain seam. */
export async function settingsRoutes(
  app: FastifyInstance,
  dependencies: SettingsRouteDependencies
): Promise<void> {
  app.get("/api/settings", async () => dependencies.readEffectiveSettings());

  app.put("/api/settings", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body;
    if (!isPlainObject(body) || Object.keys(body).some((key) => !ENVELOPE_KEYS.has(key))) {
      return reply.code(400).send({ error: "invalid_envelope" });
    }
    try {
      return reply.code(200).send(dependencies.writeSettingsObject(body.object, body.settings));
    } catch (error) {
      if (dependencies.isValidationError(error))
        return reply.code(400).send({ error: (error as Error).message });
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });
}
