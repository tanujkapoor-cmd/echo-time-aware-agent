import assert from "node:assert/strict";
import test from "node:test";
import { readEvents, streamMessage } from "../lib/sse.ts";

const request = { session_id: "fixture", message: "Hello", request_id: "request" };
const reply = { message_id: "reply", answer: "Hello 🌱", timestamp: "2026-01-01T00:00:00Z" };
const frame = (name, data) => "event: " + name + "\r\ndata: " + JSON.stringify(data) + "\r\n\r\n";

function response(text, chunkSize = 2) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function callbacks() {
  const received = [];
  return {
    received,
    status: stage => received.push(["status", stage]),
    sources: sources => received.push(["sources", sources]),
    token: text => received.push(["token", text]),
  };
}

const signal = () => new AbortController().signal;

test("the SSE parser handles split UTF-8 and CRLF, comments, and multi-line data", async () => {
  const text = ": heartbeat\r\nevent: token\r\ndata: Hello 🌱\r\ndata: second line\r\n\r\n";
  const frames = [];
  for await (const frame of readEvents(response(text, 1).body)) frames.push(frame);
  assert.deepEqual(frames, [{ event: "token", data: "Hello 🌱\nsecond line" }]);
});

test("the stream forwards actual events and returns the canonical saved reply", async t => {
  t.mock.method(globalThis, "fetch", async () => response(
    frame("status", { stage: "generate_answer" }) +
    frame("sources", { citations: [] }) + frame("token", { text: "Hello 🌱" }) +
    frame("completed", { ok: true, response: reply }),
  ));
  const updates = callbacks();
  assert.deepEqual(await streamMessage(request, updates, signal()), reply);
  assert.deepEqual(updates.received, [
    ["status", "generate_answer"], ["sources", []], ["token", "Hello 🌱"],
  ]);
});

test("backend stream errors are surfaced without sending a second request", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => response(
    frame("error", { code: "model_unavailable", message: "Model unavailable.", trace_id: "trace" }) +
    frame("completed", { ok: false }),
  ));
  await assert.rejects(streamMessage(request, callbacks(), signal()), {
    code: "model_unavailable", message: "Model unavailable.", traceId: "trace",
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test("a malformed frame or missing completion fails without automatic retry", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => response("event: token\ndata: not-json\n\n"));
  await assert.rejects(streamMessage(request, callbacks(), signal()), /malformed chat event/);
  fetch.mock.mockImplementation(async () => response(frame("token", { text: "partial" })));
  await assert.rejects(streamMessage(request, callbacks(), signal()), /stream ended early/);
  assert.equal(fetch.mock.callCount(), 2);
});

test("a missing SSE endpoint falls back with the same request ID", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (path, options) => {
    calls.push([path, JSON.parse(options.body)]);
    return calls.length === 1
      ? Response.json({ detail: "Not Found" }, { status: 404 })
      : Response.json(reply);
  });
  const updates = callbacks();
  assert.deepEqual(await streamMessage(request, updates, signal()), reply);
  assert.deepEqual(calls, [["/api/v1/chat/stream", request], ["/api/v1/chat", request]]);
  assert.deepEqual(updates.received, []);
});

test("a real session error is distinct from an unavailable stream endpoint", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    error: { code: "session_not_found", message: "Conversation session not found." },
  }, { status: 404 }));
  await assert.rejects(streamMessage(request, callbacks(), signal()), { code: "session_not_found" });
  assert.equal(fetch.mock.callCount(), 1);
});
