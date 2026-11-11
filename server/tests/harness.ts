import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, defaults } from "../agent.ts";
import { createHttpApp } from "../http.ts";
import type { ChatDraft, Model, ResearchDraft, SearchPlan, SearchProvider } from "../providers.ts";
import { Store } from "../store.ts";
import type { PriceScope, Reply, SearchHit } from "../types.ts";

export function harness(now = "2026-11-11T12:00:00Z") {
  let instant = new Date(now);
  const clock = () => instant;
  const calls = { plans: [] as object[], chat: [] as object[], research: [] as object[], search: [] as string[] };
  const drafts: ChatDraft[] = [];
  const plans: SearchPlan[] = [];
  const results: ResearchDraft[] = [];
  const searches = new Map<string, SearchHit[] | Error>();
  let chatGate: (() => Promise<void>) | undefined;
  const model: Model = {
    async plan(context) {
      calls.plans.push(context);
      const value = plans.shift();
      assert(value, "Unexpected search planner call");
      return { value };
    },
    async chat(context) {
      calls.chat.push(context);
      await chatGate?.();
      return { value: drafts.shift() ?? { answer: "Fixture reply.", memories: [] } };
    },
    async research(context) {
      calls.research.push(context);
      const value = results.shift();
      assert(value, "Unexpected research extraction");
      return { value };
    },
  };
  const provider: SearchProvider = {
    async search(query) {
      calls.search.push(query);
      const result = searches.get(query);
      if (result instanceof Error) throw result;
      return (result ?? []).map(hit => ({ ...hit, retrieved_at: clock().toISOString() }));
    },
  };
  async function open(url: string, secret?: string) {
    const store = await Store.open(url);
    const agent = new Agent(store, model, provider, clock, defaults);
    const app = createHttpApp({ agent, store, clock, browserSecret: secret });
    app.addHook("onClose", async () => store.close());
    return app;
  }
  function at(time: string) { instant = new Date(time); }
  return { clock, calls, drafts, plans, results, searches, open, at,
    gateChat: (gate?: () => Promise<void>) => { chatGate = gate; } };
}

export async function databaseFile(): Promise<string> {
  return "sqlite:///" + join(await mkdtemp(join(tmpdir(), "echo-test-")), "echo.db");
}

export async function session(app: Awaited<ReturnType<ReturnType<typeof harness>["open"]>>, cookie?: string) {
  const response = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: {}, cookies: cookie ? { "__Host-echo-visitor": cookie } : {} });
  assert.equal(response.statusCode, 201, response.body);
  return { id: response.json<{ id: string }>().id, cookie: response.cookies[0]?.value ?? cookie };
}

export async function send(
  app: Awaited<ReturnType<ReturnType<typeof harness>["open"]>>,
  id: string, message: string, zone = "UTC", requestId = randomUUID(), cookie?: string,
): Promise<Reply> {
  const response = await app.inject({
    method: "POST", url: "/api/v1/chat", payload: { session_id: id, message, request_id: requestId },
    headers: { "X-Echo-Timezone": zone }, cookies: cookie ? { "__Host-echo-visitor": cookie } : {},
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Reply>();
}

export function hit(title: string, url: string, snippet: string, published_at: string | null = null): SearchHit {
  return { title, url, snippet, published_at, retrieved_at: "2026-11-03T08:00:00.000Z" };
}

export function plan(query: string, ...additional_queries: string[]): SearchPlan {
  return { query, additional_queries, max_results: 6 };
}

export function draft(entries: { source: SearchHit; subject: string; attribute: string; value: string; scope?: PriceScope }[]): ResearchDraft {
  return { excerpts: [], facts: entries.map((entry, index) => ({
    subject: entry.subject, attribute: entry.attribute, value: entry.value, scope: entry.scope ?? null,
    witness: { source_id: "R" + (index + 1), quote: entry.source.snippet },
  })) };
}

export function price(subject: string, plan: string, amount: number, url: string, unit: PriceScope["unit"], billing: PriceScope["billing"] = "monthly", currency = "USD") {
  const scope = { plan, currency, billing, unit, market: null };
  const source = hit(subject + " pricing", url, subject + " " + plan + " costs " + currency + " " + amount +
    " per " + unit + ", billed " + (billing === "annual" ? "annually" : "monthly") + ".");
  return { source, subject, attribute: "price", value: String(amount), scope };
}
