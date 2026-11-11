import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { PassThrough } from "node:stream";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Agent } from "./agent.ts";
import type { Store } from "./store.ts";
import { memoryKinds, ServiceError } from "./types.ts";
import type { Clock } from "./types.ts";

const cookieName = "__Host-echo-visitor";
const chatBody = z.strictObject({
  session_id: z.uuid(), message: z.string().trim().min(1).max(4000),
  request_id: z.uuid().nullish(), timezone: z.string().trim().min(1).max(80).optional(),
});
const titleBody = z.strictObject({ title: z.string().trim().min(1).max(120).nullish() });
const page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

interface Dependencies {
  agent: Agent;
  store: Store;
  clock: Clock;
  browserSecret?: string;
  frontendOrigin?: string;
  localUser?: string;
  logger?: boolean;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServiceError("invalid_request", "Check the session and request fields.", 422);
  return result.data;
}

function chatInput(request: FastifyRequest) {
  const input = parse(chatBody, request.body);
  const zone = request.headers["x-echo-timezone"];
  return { ...input, timezone: input.timezone ?? (typeof zone === "string" && zone.length <= 80 ? zone : undefined) };
}

function identity(request: FastifyRequest, reply: FastifyReply, deps: Dependencies): string {
  reply.header("Cache-Control", "private, no-store");
  if (!deps.browserSecret) return deps.localUser ?? "local-demo";
  const sign = (visitor: string) => createHmac("sha256", deps.browserSecret!).update(visitor).digest("hex");
  const cookie = request.headers.cookie?.split(";").map(value => value.trim())
    .find(value => value.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
  const match = /^([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(cookie ?? "");
  if (match && timingSafeEqual(Buffer.from(match[2], "hex"), Buffer.from(sign(match[1]), "hex"))) {
    return "browser:" + match[1];
  }
  const visitor = randomUUID().replaceAll("-", "");
  reply.header("Set-Cookie", cookieName + "=" + visitor + "." + sign(visitor) +
    "; Max-Age=7776000; Path=/; Secure; HttpOnly; SameSite=Lax");
  return "browser:" + visitor;
}

function publicError(error: unknown) {
  if (error instanceof ServiceError) return error;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new ServiceError("turn_timeout", "This request took too long. Try again.", 503);
  }
  const status = (error as { statusCode?: number })?.statusCode;
  if (status && status >= 400 && status < 500) {
    return new ServiceError("invalid_request", "The request couldn’t be read.", status);
  }
  return new ServiceError("internal_error", "Echo couldn’t complete this request.", 503);
}

function frame(event: string, payload: object): string {
  return "event: " + event + "\ndata: " + JSON.stringify(payload) + "\n\n";
}

export function createHttpApp(deps: Dependencies) {
  const app = Fastify({ bodyLimit: 24 * 1024, logger: deps.logger ? { level: "info", redact: ["req.headers.cookie"] } : false });
  const { agent, store, clock } = deps;

  if (deps.frontendOrigin) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.headers.origin !== deps.frontendOrigin) return;
      reply.header("Access-Control-Allow-Origin", deps.frontendOrigin!)
        .header("Access-Control-Allow-Credentials", "true").header("Vary", "Origin");
      if (request.method === "OPTIONS") {
        return reply.header("Access-Control-Allow-Methods", "GET, POST")
          .header("Access-Control-Allow-Headers", "Content-Type, X-Echo-Timezone").code(204).send();
      }
    });
    app.options("/api/v1/*", async (_request, reply) => reply.code(403).send());
  }

  app.setErrorHandler((error, request, reply) => {
    const safe = publicError(error);
    if (safe.code === "internal_error") request.log.error({ code: safe.code }, "Echo request failed");
    return reply.code(safe.status).send({ error: { code: safe.code, message: safe.message, trace_id: null } });
  });

  app.get("/api/v1/health", async (_request, reply) => {
    await store.healthy();
    reply.header("X-Echo-Runtime", "node");
    return { status: "ok" };
  });

  app.post("/api/v1/sessions", async (request, reply) => {
    const user = identity(request, reply, deps);
    const { title } = parse(titleBody, request.body ?? {});
    const session = await store.createSession(user, title ?? null, clock().toISOString());
    return reply.code(201).send(session);
  });

  app.get("/api/v1/sessions", async (request, reply) => {
    const user = identity(request, reply, deps);
    const { limit, offset } = parse(page, request.query);
    return store.sessions(user, limit, offset);
  });

  app.get<{ Params: { id: string } }>("/api/v1/sessions/:id/messages", async (request, reply) => {
    const user = identity(request, reply, deps);
    const id = parse(z.uuid(), request.params.id);
    const { limit, after } = parse(page.extend({ after: z.coerce.number().int().min(0).default(0) }), request.query);
    return (await store.turns(user, id, after, limit)).flatMap(turn => [
      { id: turn.user_message_id, role: "user", content: turn.question, timestamp: turn.asked_at, response: null },
      { id: turn.id, role: "assistant", content: turn.response.answer, timestamp: turn.answered_at, response: turn.response },
    ]);
  });

  app.get("/api/v1/memories", async (request, reply) => {
    const user = identity(request, reply, deps);
    const { limit, offset, kind, include_superseded } = parse(page.extend({
      kind: z.enum(memoryKinds).optional(), include_superseded: z.enum(["true", "false"]).default("false"),
    }), request.query);
    return (await store.memories(user, kind ?? null, include_superseded === "true", limit, offset))
      .map(({ source_message_id, active_key, ...memory }) => ({
        ...memory, source_message_ids: [source_message_id], active: active_key !== null,
        extraction_status: "explicit_user_quote",
      }));
  });

  app.post("/api/v1/chat", async (request, reply) => {
    const user = identity(request, reply, deps);
    const input = chatInput(request);
    const trace = randomUUID();
    const abort = new AbortController();
    reply.raw.once("close", () => { if (!reply.raw.writableEnded) abort.abort(); });
    try {
      return await agent.chat(user, input, trace, abort.signal, () => {});
    } catch (error) {
      const safe = publicError(error);
      if (safe.code === "internal_error") request.log.error({ trace }, "Echo turn failed");
      return reply.code(safe.status).send({ error: { code: safe.code, message: safe.message, trace_id: trace } });
    }
  });

  app.post("/api/v1/chat/stream", async (request, reply) => {
    const user = identity(request, reply, deps);
    const input = chatInput(request);
    const trace = randomUUID();
    const output = new PassThrough();
    const abort = new AbortController();
    const heartbeat = setInterval(() => output.write(": heartbeat\n\n"), 10_000);
    output.once("close", () => { clearInterval(heartbeat); if (!output.writableEnded) abort.abort(); });
    reply.raw.once("close", () => { if (!reply.raw.writableEnded) output.destroy(); });

    void agent.chat(user, input, trace, abort.signal,
      stage => output.write(frame("status", { stage, trace_id: trace })))
      .then(result => {
        output.write(frame("sources", { citations: result.citations }));
        for (const text of result.answer.match(/\S+\s*|\s+/g) ?? []) output.write(frame("token", { text }));
        output.end(frame("completed", { ok: true, response: result }));
      }, error => {
        if (output.destroyed) return;
        const safe = publicError(error);
        if (safe.code === "internal_error") request.log.error({ trace }, "Echo streamed turn failed");
        output.write(frame("error", { code: safe.code, message: safe.message, trace_id: trace }));
        output.end(frame("completed", { ok: false, trace_id: trace }));
      }).finally(() => clearInterval(heartbeat));

    return reply.type("text/event-stream; charset=utf-8").header("X-Accel-Buffering", "no").send(output);
  });

  return app;
}
