import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";
import type { Reply } from "./types.ts";

const base = process.env.ECHO_EVAL_BASE_URL ?? "http://127.0.0.1:3000";
const pause = Number(process.env.ECHO_EVAL_PAUSE_MS ?? 0);
if (!Number.isFinite(pause) || pause < 0 || pause > 60_000) throw new Error("ECHO_EVAL_PAUSE_MS must be between 0 and 60000.");
let cookie: string | undefined;

async function post<T>(route: string, payload: object): Promise<T> {
  const response = await fetch(new URL("/api/v1/" + route, base), {
    method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(50_000),
  });
  if (!cookie) cookie = response.headers.getSetCookie()[0]?.split(";")[0];
  const value = await response.json();
  if (!response.ok) throw new Error(route + " HTTP " + response.status + " " + (value?.error?.code ?? ""));
  return value as T;
}

const basic = await post<{ id: string }>("sessions", { title: "Echo live audit · chat" });
const research = await post<{ id: string }>("sessions", { title: "Echo live audit · research" });
const cases = [
  { name: "binary-search", session: basic.id, message: "How would binary search find 5 in [1, 3, 5, 7, 9]?", search: false, check: /middle|index/i },
  { name: "context-setup", session: basic.id, message: "My transit feed refreshes every 15 minutes. How should I show freshness?", search: false },
  { name: "context-followup", session: basic.id, message: "When should I label the data as stale? Use the refresh interval above.", search: false, check: /15 minutes/i },
  { name: "official-release", session: research.id, message: "What is the latest stable Python release? Cite the official Python downloads page.", search: true, domains: ["python.org"] },
  { name: "release-recheck", session: research.id, message: "Has anything changed since I last asked?", search: true },
  { name: "no-history", session: research.id, message: "What did I ask you on 3 November 2010? Is your answer still correct today?", search: false, check: /saved question/i },
  { name: "postgres-pricing", session: research.id, message: "Search the web for current Render PostgreSQL and Neon prices. Prefer official provider pricing pages and include plan and billing details where available.", search: true, domains: ["render.com", "neon.com"] },
  { name: "short-explanation", session: basic.id, message: "Explain a database index in two sentences.", search: false, check: /index/i },
  { name: "simple-reasoning", session: basic.id, message: "What is the sum of the first five positive integers?", search: false, check: /\b15\b/ },
  { name: "context-recall", session: basic.id, message: "What did I tell you about my transit feed?", search: false, check: /15 minutes/i },
];

const results: { name: string; http_ms: number; reply: Reply }[] = [];
let failed = 0;
for (const item of cases) {
  if (pause) await wait(pause);
  const started = performance.now();
  try {
    const reply = await post<Reply>("chat", { session_id: item.session, message: item.message, request_id: randomUUID(), timezone: "America/New_York" });
    const http_ms = Math.round(performance.now() - started);
    results.push({ name: item.name, http_ms, reply });
    const domains = reply.citations.map(source => new URL(source.url).hostname.replace(/^www\./, ""));
    console.log(JSON.stringify({ case: item.name, http_ms, search: reply.search_status,
      memory: reply.memory_used, changes: reply.changes.map(change => change.kind), domains,
      sources: reply.citations.map(source => ({ url: source.url, quote: source.quote })),
      answer: reply.answer.slice(0, 450), timing: reply.timing }));
    assert.equal(reply.web_search_used, item.search);
    assert.doesNotMatch(reply.answer, /^\s*print\s+42\s*$/i);
    if (item.check) assert.match(reply.answer, item.check);
    if (item.domains) assert(item.domains.some(domain => domains.includes(domain)), "No official cited source");
    if (item.name === "release-recheck") assert(reply.baseline_at && reply.memory_used, "Missing baseline");
  } catch (error) {
    failed++;
    console.error(item.name + ": " + (error instanceof Error ? error.message : "failed"));
  }
}

function metrics(numbers: number[]) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? Math.round(sorted[Math.ceil(p * sorted.length) - 1]) : null;
  return { n: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}

console.log(JSON.stringify({
  turns: results.length, failed, http_ms: metrics(results.map(row => row.http_ms)),
  model_ms: metrics(results.filter(row => row.reply.timing.model_calls).map(row => row.reply.timing.llm_ms)),
  web_ms: metrics(results.filter(row => row.reply.timing.search_calls).map(row => row.reply.timing.search_ms)),
  memory_ms: metrics(results.map(row => row.reply.timing.memory_ms)),
  search_calls: results.reduce((count, row) => count + row.reply.timing.search_calls, 0),
}));
if (failed) process.exitCode = 1;
