import { normalizeBasePath, requestAppPath } from "../shared/base-path";
import fs from "node:fs";
import path from "node:path";
import type { Socket } from "node:net";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { authBoundary, classifyApiRequest } from "./auth/boundary";
import { isQuiesced, beginRequest, endRequest, RESTORE_ROUTE_PATH } from "./backups/restore";
import { healthRoutes } from "./routes/health";
import { provisionRoutes } from "./routes/provision";
import { settingsModule } from "./modules/settings";
import { verifyPinRoutes } from "./routes/verify-pin";
import { deviceCredentialsRoutes } from "./routes/device-credentials";
import { membersRoutes } from "./routes/members";
import { dayPeriodsRoutes } from "./routes/day-periods";
import { calendarRoutes } from "./routes/calendar";
import { routinesRoutes } from "./routes/routines";
import { remindersRoutes } from "./routes/reminders";
import { mealsRoutes } from "./routes/meals";
import { dailyMessagesRoutes } from "./routes/daily-messages";
import { dailyBriefingRoutes } from "./routes/daily-briefing";
import { telemetryRoutes } from "./routes/telemetry";
import { backupsRoutes } from "./routes/backups";
import { timeAnnouncementsRoutes } from "./routes/time-announcements";
import { weatherRoutes } from "./routes/weather";
import { networkDevicesRoutes } from "./routes/network-devices";
import { printingRoutes } from "./routes/printing";
import { accessGate, hasValidGateCookie, sendGateForm } from "./auth/gate";
import { pluginRoutes } from "./plugins/routes";
import type { PluginLifecycle } from "./plugins/lifecycle";
import {
  createServerPluginLifecycle,
  registerPluginHttp,
  type PluginRouteRegistrar,
} from "./plugins/http";
import type { PluginId } from "../shared/plugins";
import type { CalendarFeedDependencies } from "./modules/calendar/sync-coordinator";
import { defaultCredentialsMetaTag } from "./auth/default-credentials";
import { openApiDocsRoutes, registerOpenApi } from "./openapi";

type QuiesceCountedRequest = FastifyRequest & {
  __quiesceCounted?: boolean;
  __quiesceHandlerActive?: boolean;
  __quiesceTransportEnded?: boolean;
};

/** A disconnected client does not cancel its handler; release only after both have finished. */
function releaseInFlightSlot(request: QuiesceCountedRequest): void {
  request.__quiesceTransportEnded = true;
  if (request.__quiesceCounted && !request.__quiesceHandlerActive) {
    request.__quiesceCounted = false;
    endRequest();
  }
}

export interface BuildAppOptions {
  staticRoot?: string;
  calendarFeed?: CalendarFeedDependencies;
  pluginLifecycle?: PluginLifecycle;
  pluginRouteRegistrars?: Partial<Record<PluginId, PluginRouteRegistrar>>;
}

export async function buildApp(opts?: BuildAppOptions): Promise<FastifyInstance> {
  const basePath = normalizeBasePath(process.env.BASE_PATH);
  const pluginLifecycle = opts?.pluginLifecycle ?? createServerPluginLifecycle();
  // startup barrier: no Fastify instance (and therefore no injectable/listening traffic)
  // exists until every durable lifecycle operation has reached its reconciled safe outcome.
  await pluginLifecycle.reconcileAll();
  // Router normalization is pinned to Fastify's strict defaults (and no `rewriteUrl`; a `;` is
  // not a path delimiter, also the default) so the
  // URL path the frontend gate and the not-found handler classify stays the path the router
  // matches. The API-key boundary does not rely on this: it also classifies by the matched
  // route (see classifyApiRequest), so any spelling the router still normalizes (such as an
  // absolute-form target) is authenticated wherever it reaches an /api handler.
  const server = Fastify({
    routerOptions: {
      caseSensitive: true,
      ignoreTrailingSlash: false,
      ignoreDuplicateSlashes: false,
    },
  });
  // Code-first OpenAPI: documentation-only route schemas, collected from every route below.
  await registerOpenApi(server, basePath);
  const sockets = new Set<Socket>();
  let closingHttp = false;
  let idleCollector: ReturnType<typeof setInterval> | undefined;
  function forgetSocket(this: Socket): void {
    sockets.delete(this);
  }
  function trackSocket(socket: Socket): void {
    sockets.add(socket);
    socket.once("close", forgetSocket);
    // No accepted HTTP operation exists on a connection that has read no bytes.
    // This also covers a connection accepted while preClose is running.
    if (closingHttp && socket.bytesRead === 0) socket.destroy();
  }
  function stopIdleCollector(): void {
    clearInterval(idleCollector);
    server.server.off("connection", trackSocket);
    server.server.off("close", stopIdleCollector);
    for (const socket of sockets) socket.off("close", forgetSocket);
    sockets.clear();
  }
  server.server.on("connection", trackSocket);
  server.addHook("preClose", async () => {
    closingHttp = true;
    for (const socket of sockets) {
      if (socket.bytesRead === 0) socket.destroy();
    }
    // Node's initial close sweep misses responses becoming idle later. Its own
    // idle classifier preserves active requests and incomplete HTTP headers.
    // ponytail: poll only during shutdown; replace with a native fix when available.
    idleCollector = setInterval(() => server.server.closeIdleConnections(), 25);
    idleCollector.unref();
    server.server.once("close", stopIdleCollector);
  });
  server.addHook("onClose", async () => stopIdleCollector());
  server.addHook("onRequest", async (request, reply) => {
    // Only origin-form request targets (`/path?query`) are served. The router would still match
    // an absolute-form (`scheme://authority/path`) or asterisk-form target by dropping what
    // precedes the path, while every URL-based classification below (the frontend gate, the
    // API-key boundary, BASE_PATH mounting) reads the target as sent; one shape keeps them all
    // looking at the path the router matches. Browsers and API clients always send origin-form
    // to an origin server; absolute-form is only meant for forward proxies.
    if (!request.url.startsWith("/")) return reply.code(400).send({ error: "bad_request" });
    if (request.url.split("?")[0] === "/health") return;
    if (requestAppPath(request.url, basePath) === null)
      return reply.code(404).send({ error: "not_found" });
    if (
      basePath &&
      request.url.split("?")[0] === basePath &&
      (request.method === "GET" || request.method === "HEAD")
    )
      return reply.redirect(
        `${basePath}/${request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : ""}`
      );
  });
  await healthRoutes(server);
  const app = server;
  // Keep handler completion separate from transport completion. The restore request itself
  // remains exempt, because counting it would make its own drain target unreachable.
  app.addHook("onRoute", (route) => {
    const handler = route.handler;
    route.handler = async function (request, reply) {
      const counted = request as QuiesceCountedRequest;
      if (counted.__quiesceTransportEnded) return;
      counted.__quiesceHandlerActive = true;
      try {
        return await handler.call(this, request, reply);
      } finally {
        counted.__quiesceHandlerActive = false;
        if (counted.__quiesceTransportEnded) releaseInFlightSlot(counted);
      }
    };
  });
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Same classification as the API-key boundary: every request that reaches an /api handler.
    const api = classifyApiRequest(request, basePath);
    if (!api) return;
    if (request.method === "POST" && api.path === RESTORE_ROUTE_PATH) return;

    if (isQuiesced()) {
      reply.header("Retry-After", "2");
      return reply.code(503).send({
        error: "quiescing",
        message: "The server is restoring a backup. Try again shortly.",
      });
    }
    beginRequest();
    const counted = request as QuiesceCountedRequest;
    counted.__quiesceCounted = true;
    // Aborted sockets may bypass onResponse; all release paths are idempotent.
    reply.raw.once("close", () => releaseInFlightSlot(counted));
  });
  app.addHook("onRequestAbort", async (request: FastifyRequest) => {
    releaseInFlightSlot(request as QuiesceCountedRequest);
  });
  app.addHook("onResponse", async (request: FastifyRequest) => {
    releaseInFlightSlot(request as QuiesceCountedRequest);
  });

  await authBoundary(app, basePath);
  await accessGate(app, basePath);
  await server.register(
    async (app) => {
      await provisionRoutes(app, basePath);
      await settingsModule(app);
      await verifyPinRoutes(app);
      await deviceCredentialsRoutes(app);
      await membersRoutes(app);
      await dayPeriodsRoutes(app);
      await calendarRoutes(app, opts?.calendarFeed);
      await routinesRoutes(app);
      await telemetryRoutes(app);
      const pluginRouteRegistrars: Record<PluginId, PluginRouteRegistrar> = {
        "daily-briefing": dailyBriefingRoutes,
        printing: printingRoutes,
        weather: weatherRoutes,
        "time-announcements": timeAnnouncementsRoutes,
        backups: (app) => backupsRoutes(app, pluginLifecycle),
        "network-devices": networkDevicesRoutes,
        "meals-recipes": mealsRoutes,
        reminders: remindersRoutes,
        "daily-messages": dailyMessagesRoutes,
        ...opts?.pluginRouteRegistrars,
      };
      for (const [pluginId, registerRoutes] of Object.entries(pluginRouteRegistrars) as Array<
        [PluginId, PluginRouteRegistrar]
      >) {
        await registerPluginHttp(app, pluginLifecycle, pluginId, registerRoutes);
      }
      await pluginRoutes(app, pluginLifecycle);
      await openApiDocsRoutes(app);

      // FR-028 / ADR-059 §5: serve the built SPA same-origin from the CLIENT build dir
      // ONLY (dist/client/). The server bundle lives OUTSIDE this root (dist/server/) so
      // it can never be downloaded — GET /server.js and any *.js/*.mjs server artifact
      // MUST NOT leak backend code. Registered only when a client build
      // exists; the boundary/integration tests build via inject with no build and must
      // not require one, so serving is skipped under VITEST. Tests that need to exercise
      // serving pass an explicit `staticRoot`.
      const clientRoot = opts?.staticRoot ?? path.resolve(process.cwd(), "dist", "client");
      const serve = opts?.staticRoot
        ? true
        : !process.env.VITEST && fs.existsSync(path.join(clientRoot, "index.html"));
      if (serve) {
        const html = fs
          .readFileSync(path.join(clientRoot, "index.html"), "utf8")
          .replace(
            /<head(?:\s[^>]*)?>/i,
            (head) =>
              `${head}<base href="${basePath}/"><meta name="mp-base-path" content="${basePath}">${defaultCredentialsMetaTag()}`
          );
        const sendShell = (reply: FastifyReply) =>
          reply.type("text/html; charset=utf-8").send(html);
        app.addHook("onRequest", async (request, reply) => {
          const pathname = requestAppPath(request.url, basePath);
          if (request.method !== "GET" && request.method !== "HEAD") return;
          if (pathname === "/" || pathname === "/index.html") return sendShell(reply);
        });
        await app.register(fastifyStatic, { root: clientRoot, wildcard: false });
        app.setNotFoundHandler((request, reply) => {
          const pathname = requestAppPath(request.url, basePath) ?? "";
          // A path with a file extension (e.g. /server.js) is a FILE request: if it isn't
          // present in the client root it 404s — it never falls through to the SPA shell.
          // Extension-less non-/api, non-/health GETs are client ROUTES → serve index.html.
          const looksLikeFile = /\.[a-zA-Z0-9]+$/.test(pathname);
          if (
            request.method === "GET" &&
            !pathname.startsWith("/api/") &&
            pathname !== "/health" &&
            !looksLikeFile
          ) {
            if (!hasValidGateCookie(request.headers.cookie)) {
              return sendGateForm(reply, basePath);
            }
            return sendShell(reply);
          }
          return reply.code(404).send({ error: "not_found" });
        });
      }
    },
    { prefix: basePath }
  );
  return server;
}
