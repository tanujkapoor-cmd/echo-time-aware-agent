import assert from "node:assert/strict";
import test from "node:test";
import { createSession, listMemories, listMessages, sendMessage } from "../lib/api.ts";

const session = { id: "fixture", title: "First", created_at: "2026-01-01T00:00:00Z" };
const request = { session_id: session.id, message: "Hello", request_id: "request" };

test("session creation sends the title and uses the same-origin API", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(session, { status: 201 }));
  assert.deepEqual(await createSession("First"), session);
  const [[path, options]] = fetch.mock.calls.map(call => call.arguments);
  assert.equal(path, "/api/v1/sessions");
  assert.equal(options.method, "POST");
  assert.deepEqual(JSON.parse(options.body), { title: "First" });
});

test("history pagination counts turns and retains the backend message order", async t => {
  const messages = Array.from({ length: 202 }, (_, index) => ({
    id: String(index), role: index % 2 ? "assistant" : "user",
    content: "Message " + index, timestamp: session.created_at,
  }));
  const calls = [];
  t.mock.method(globalThis, "fetch", async path => {
    calls.push(path);
    return Response.json(calls.length === 1 ? messages.slice(0, 200) : messages.slice(200));
  });
  assert.deepEqual(await listMessages("a/b"), messages);
  assert.deepEqual(calls, [
    "/api/v1/sessions/a%2Fb/messages?limit=100&after=0",
    "/api/v1/sessions/a%2Fb/messages?limit=100&after=100",
  ]);
});

test("server errors retain the backend's code, message and trace ID", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    error: { code: "session_not_found", message: "Session was not found.", trace_id: "trace" },
  }, { status: 404 }));
  await assert.rejects(sendMessage(request), {
    name: "ApiError", status: 404, code: "session_not_found",
    message: "Session was not found.", traceId: "trace",
  });
});

test("saved memory includes superseded records and keeps backend ordering across pages", async t => {
  const memories = Array.from({ length: 101 }, (_, index) => ({
    id: String(index), kind: "project", content: "Project " + index,
    observed_at: session.created_at, created_at: session.created_at, source_message_ids: ["user"],
    active: index === 0, superseded_at: index === 0 ? null : session.created_at,
  }));
  const fetch = t.mock.method(globalThis, "fetch", async path =>
    Response.json(path.endsWith("offset=0") ? memories.slice(0, 100) : memories.slice(100)));
  assert.deepEqual(await listMemories(), memories);
  assert.deepEqual(fetch.mock.calls.map(call => call.arguments[0]), [
    "/api/v1/memories?include_superseded=true&limit=100&offset=0",
    "/api/v1/memories?include_superseded=true&limit=100&offset=100",
  ]);
});

test("an empty answer is reported as a response error", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    message_id: "reply", timestamp: session.created_at, answer: " ",
  }));
  await assert.rejects(sendMessage(request), /empty or invalid answer/);
});

test("a network failure gives a useful message and an aborted request remains canceled", async t => {
  const controller = new AbortController();
  const networkError = new TypeError("Failed to fetch");
  t.mock.method(globalThis, "fetch", async () => { throw networkError; });
  await assert.rejects(sendMessage(request), /Check that both servers are running/);
  controller.abort();
  await assert.rejects(sendMessage(request, controller.signal), error => error === networkError);
});
