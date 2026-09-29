import type { FastifyInstance } from "fastify";
import { provisionDevice } from "../auth/provision";

/** Provisioning routes — POST /auth/provision.
 * FR-007: Validate the presented raw `*` bootstrap key, mint a
 * cookie-bound device key, return `{provisioned: true}` with no raw key.
 */
export async function provisionRoutes(app: FastifyInstance): Promise<void> {
  await provisionDevice(app);
}
