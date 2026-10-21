import type { FastifyInstance } from "fastify";
import { bootstrapSchemas } from "../openapi/bootstrap";
import { documented } from "../openapi/zod";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", documented(bootstrapSchemas.getHealth), async () => ({
    status: "ok" as const,
  }));
}
