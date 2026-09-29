import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getDb } from "../db/client";
import { verifyPin } from "../auth/pin";

/** POST /auth/verify-pin — key-authorized PIN verification.
 * Reads the `mp_device_key` cookie (gated by the existing boundary hook),
 * hash-compares the submitted PIN against the stored `admin_config.pin_hash`,
 * and returns `{ match: boolean }` with NO session and NO DB writes.
 */
export async function verifyPinRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/verify-pin", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { pin?: string };
    const pin = body?.pin;

    if (pin === undefined || pin === null) {
      return reply.code(400).send({ match: false });
    }

    const db = getDb();
    const row = db.prepare("SELECT pin_hash FROM admin_config WHERE id = 1").get() as
      { pin_hash: string } | undefined;

    if (!row) {
      return reply.code(200).send({ match: false });
    }

    const match = await verifyPin(row.pin_hash, pin);
    return reply.code(200).send({ match });
  });
}
