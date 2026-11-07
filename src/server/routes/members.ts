import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { MemberColorKey } from "../../shared";
import {
  archiveMember,
  createMember,
  editMember,
  listMembersWithLifecycle,
  MemberNotFoundError,
  MemberValidationError,
  restoreMember,
} from "../modules/members";
import { membersSchemas } from "../openapi/members";
import { documented } from "../openapi/zod";

export async function membersRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/members",
    documented(membersSchemas.createMember),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const member = await createMember(request.body);
        return reply.code(201).send(member);
      } catch (e) {
        if (e instanceof MemberValidationError) {
          return reply.code(400).send({ error: "validation_error", message: e.message });
        }
        throw e;
      }
    }
  );

  app.get(
    "/api/members",
    documented(membersSchemas.listMembers),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const lifecycle = (request.query as { lifecycle?: string }).lifecycle;
        const members = listMembersWithLifecycle(lifecycle);
        return reply.code(200).send(members);
      } catch (e) {
        if (e instanceof MemberValidationError) {
          return reply.code(400).send({ error: "validation_error", message: e.message });
        }
        throw e;
      }
    }
  );

  app.patch(
    "/api/members/:id",
    documented(membersSchemas.updateMember),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const id = (request.params as { id: string }).id;
        const patch = request.body as {
          displayName?: string;
          role?: "parent" | "child";
          colorKey?: MemberColorKey;
          birthDate?: { month: number; day: number; year: number | null } | null;
          celebration?: unknown;
        };
        const member = editMember(id, patch ?? {});
        return reply.code(200).send(member);
      } catch (e) {
        if (e instanceof MemberNotFoundError) {
          return reply.code(404).send({ error: "not_found", message: e.message });
        }
        if (e instanceof MemberValidationError) {
          return reply.code(400).send({ error: "validation_error", message: e.message });
        }
        throw e;
      }
    }
  );

  app.post(
    "/api/members/:id/archive",
    documented(membersSchemas.archiveMember),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const id = (request.params as { id: string }).id;
        const member = archiveMember(id);
        return reply.code(200).send(member);
      } catch (e) {
        if (e instanceof MemberNotFoundError) {
          return reply.code(404).send({ error: "not_found", message: e.message });
        }
        throw e;
      }
    }
  );

  app.post(
    "/api/members/:id/restore",
    documented(membersSchemas.restoreMember),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const id = (request.params as { id: string }).id;
        const member = restoreMember(id);
        return reply.code(200).send(member);
      } catch (e) {
        if (e instanceof MemberNotFoundError) {
          return reply.code(404).send({ error: "not_found", message: e.message });
        }
        throw e;
      }
    }
  );
}
