import assert from "node:assert/strict";
import test from "node:test";
import { ChatCompletions, Tavily } from "../providers.ts";

const signal = new AbortController().signal;

function modelFetch(build: (payload: Record<string, unknown>, input: string) => Response): typeof fetch {
  return async (input, init) => build(JSON.parse(String(init?.body)), String(input));
}

for (const provider of ["groq", "openai"] as const) {
  test(provider + " exposes exactly web_search and parses only the structured answer channel", async () => {
    const adapter = new ChatCompletions({ provider, key: "fixture", model: "fixture", timeout: 1000 },
      modelFetch((payload, url) => {
        assert(url.startsWith(provider === "groq" ? "https://api.groq.com/" : "https://api.openai.com/"));
        if (payload.tools) {
          const tools = payload.tools as { function: { name: string } }[];
          assert.deepEqual(tools.map(tool => tool.function.name), ["web_search"]);
          assert(!payload.response_format);
          return Response.json({ choices: [{ message: { tool_calls: [{
            type: "function", function: { name: "web_search", arguments: '{"query":"Python releases","max_results":3,"additional_queries":[]}' },
          }] } }] });
        }
        assert(!payload.tool_choice);
        assert(payload.response_format);
        return Response.json({ choices: [{ message: {
          content: '{"answer":"Binary search halves a sorted list.","memories":[]}', reasoning: "print 42",
        } }] });
      }));
    assert.equal((await adapter.plan({ question: "Latest Python?" }, signal)).value.query, "Python releases");
    assert.equal((await adapter.chat({}, signal)).value.answer, "Binary search halves a sorted list.");
  });
}

test("invalid keys, rate limits, outages, empty replies, and malformed or foreign tool calls are rejected", async () => {
  const reply = (body: object) => Response.json({ choices: [{ message: body }] });
  const cases = [
    { expected: "model_auth", operation: "chat", make: () => new Response("credential detail", { status: 401 }) },
    { expected: "model_rate_limit", operation: "chat", make: () => new Response("rate detail", { status: 429 }) },
    { expected: "model_quota", operation: "chat", make: () => Response.json({
      error: { code: "credit_balance_exhausted" },
    }, { status: 429 }) },
    { expected: "model_unavailable", operation: "chat", make: () => new Response("outage detail", { status: 502 }) },
    { expected: "model_unavailable", operation: "chat", make: () => reply({ content: "" }) },
    { expected: "model_unavailable", operation: "chat", make: () => reply({ content: "print 42" }) },
    { expected: "invalid_search_plan", operation: "plan", make: () => reply({ tool_calls: [{
      type: "function", function: { name: "web_search", arguments: "{bad json" },
    }] }) },
    { expected: "invalid_search_plan", operation: "plan", make: () => reply({ tool_calls: [{
      type: "function", function: { name: "python", arguments: "{}" },
    }] }) },
  ] as const;
  for (const entry of cases) {
    const adapter = new ChatCompletions({ provider: "groq", key: "fixture", model: "fixture", timeout: 1000 },
      modelFetch(entry.make));
    await assert.rejects(adapter[entry.operation]({}, signal), { code: entry.expected });
  }
});

test("Tavily adapter bounds output and preserves publication and retrieval times separately", async () => {
  const adapter = new Tavily("fixture", 500, () => new Date("2026-11-11T10:30:00Z"),
    modelFetch((payload, url) => {
      assert.equal(url, "https://api.tavily.com/search");
      assert.equal(payload.include_answer, false);
      assert.equal(payload.max_results, 2);
      return Response.json({ results: [
        { title: "Official", url: "https://python.org/downloads/", content: "An actual release entry.", published_date: "2026-11-09" },
        { title: "Private", url: "http://127.0.0.1/admin", content: "Not a public source." },
        { title: "Script", url: "javascript:alert(1)", content: "Not a valid source." },
      ] });
    }));
  const hits = await adapter.search("Python", 2, signal);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].published_at, "2026-11-09T00:00:00.000Z");
  assert.equal(hits[0].retrieved_at, "2026-11-11T10:30:00.000Z");
});
