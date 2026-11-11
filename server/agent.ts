import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { citeComparison, compare, ground, historicalCitations, renderCitations, summarizeComparison } from "./evidence.ts";
import { publicUrl, safeQuery } from "./providers.ts";
import type { Model, SearchPlan, SearchProvider } from "./providers.ts";
import { canSaveMemory, forceSearch, freshness, historicalWindow, overlap, refersBack, route, terms, timezone } from "./routing.ts";
import type { MemoryUpdate, Store } from "./store.ts";
import { ServiceError } from "./types.ts";
import type { Clock, Reply, SearchHit, Snapshot, Timing, Turn } from "./types.ts";

export interface AgentSettings {
  turnTimeout: number;
  searchCalls: number;
  searchResults: number;
  cacheSize: number;
  ttl: Record<ReturnType<typeof freshness>, number>;
}

export const defaults: AgentSettings = {
  turnTimeout: 35_000, searchCalls: 2, searchResults: 4, cacheSize: 256,
  ttl: { news: 900_000, market: 3_600_000, release: 21_600_000, general: 86_400_000 },
};

export interface ChatRequest {
  session_id: string;
  message: string;
  request_id?: string | null;
  timezone?: string;
}

type Context = Awaited<ReturnType<Store["context"]>>;
type Progress = (stage: string) => void;
interface CacheEntry { hits: SearchHit[]; until: number }

function contextTurn(turn: Turn) {
  return { id: turn.id, asked_at: turn.asked_at, user: turn.question.slice(0, 1500),
    assistant: turn.response.answer.slice(0, 1600) };
}

function selectTarget(message: string, rows: Turn[], window: boolean): Turn | undefined {
  const ranked = rows.map(turn => ({ turn, score: overlap(message, turn.question) }))
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return;
  if (ranked[0].score > 0) {
    if (window && ranked[1]?.score === ranked[0].score) return;
    return ranked[0].turn;
  }
  if (!terms(message).length && (!window || rows.length === 1)) return rows[0];
}

function selectSnapshot(message: string, session: string, ctx: Context, target: Turn | undefined, dated: boolean) {
  if (target) {
    const exact = ctx.snapshots.find(snapshot => snapshot.id === target.id);
    if (exact || dated) return exact;
  }
  if (dated) return;
  const ranked = ctx.snapshots.map(snapshot => ({
    snapshot, score: overlap(message, snapshot.question + " " + snapshot.topic_key),
  })).sort((a, b) => b.score - a.score);
  if (ranked[0]?.score) {
    const best = ranked.filter(item => item.score === ranked[0].score);
    if (new Set(best.map(item => item.snapshot.topic_key)).size === 1) return best[0].snapshot;
    return best.find(item => item.snapshot.session_id === session)?.snapshot;
  }
  if (!terms(message).length || refersBack.test(message)) {
    const local = ctx.snapshots.find(snapshot => snapshot.session_id === session);
    if (local && (!target || !terms(target.question).length ||
        overlap(target.question, local.question + " " + local.topic_key))) return local;
    if (!ctx.recent.length && !terms(message).length &&
        new Set(ctx.snapshots.map(snapshot => snapshot.topic_key)).size === 1) return ctx.snapshots[0];
  }
}

function previousAnswer(turn: Turn): string {
  const ids = new Map(turn.response.citations.filter(item => publicUrl(item.url))
    .map((item, index) => [item.id, "H" + (index + 1)]));
  const answer = turn.response.answer.replace(/\[((?:S|H)\d+)\]/g,
    (_, id: string) => ids.has(id) ? "[" + ids.get(id) + "]" : "");
  return answer.split("\n").map(line => "> " + line).join("\n");
}

function recall(turn: Turn, date: string): string {
  return "On " + date + ", you asked:\n\n> " + turn.question.replace(/\n/g, "\n> ") +
    "\n\nI replied:\n\n" + previousAnswer(turn);
}

function modelAnswer(answer: string): string {
  return answer.replace(/\[([^\]]+)\]\(\s*(?:https?:\/\/|www\.)[^)\s]+[^)]*\)/gi, "$1")
    .replace(/(?:https?:\/\/|www\.)[^\s<>()]+/gi, "")
    .replace(/\[(?:S|H)\d+\]/g, "").trim();
}

function remembered(updates: MemoryUpdate[], question: string): MemoryUpdate[] {
  if (!canSaveMemory(question)) return [];
  const seen = new Set<string>();
  return updates.slice(0, 3).flatMap(update => {
    const key = update.key.trim().toLowerCase().replace(/\s+/g, "-");
    const quote = update.quote.trim();
    const slot = update.kind + ":" + key;
    if (!/^[a-z0-9][a-z0-9_-]{0,69}$/.test(key) || seen.has(slot) ||
        quote.length < 4 || quote.length > 400 || !safeQuery(quote) ||
        /\b(?:password|secret|api.?key|access.?token|credit card|social security)\b/i.test(quote) ||
        !question.includes(quote)) return [];
    seen.add(slot);
    return [{ ...update, key, quote }];
  });
}

function validHits(hits: SearchHit[]): SearchHit[] {
  return hits.filter(hit => publicUrl(hit.url) && hit.title.trim() && hit.snippet.trim() &&
    Number.isFinite(Date.parse(hit.retrieved_at)));
}

function queryTasks(plan: SearchPlan, message: string, budget: number) {
  const planned = [...new Set([plan.query, ...plan.additional_queries].filter(safeQuery))];
  const sites = [...new Set([...message.matchAll(/(?:^|\s|\()(?:https?:\/\/)?((?:[a-z\d-]+\.)+[a-z]{2,})\/[a-z\d][\w/-]*/gi)]
    .map(match => match[1].toLowerCase().replace(/^www\./, ""))
    .filter(domain => domain.length <= 253 && publicUrl("https://" + domain)))];
  if (sites.length < 2 || sites.length > budget || freshness(message) !== "market") {
    return planned.slice(0, budget).map(query => ({ query, domain: undefined }));
  }

  // A multi-vendor request names the scope even if the model omitted one of the searches.
  return sites.slice(0, budget).map(domain => {
    const vendor = domain.split(".")[0];
    const scopedPlan = planned.find(query => {
      const keywords = terms(query);
      return keywords.includes(vendor) && sites.every(other => other === domain || !keywords.includes(other.split(".")[0]));
    });
    const prefix = "site:" + domain + " ";
    const query = prefix + (scopedPlan ?? vendor + " official plan pricing").slice(0, 400 - prefix.length);
    return { query, domain };
  });
}

export class Agent {
  private store: Store;
  private model: Model;
  private provider: SearchProvider;
  private clock: Clock;
  private options: AgentSettings;
  private cache = new Map<string, CacheEntry>();

  constructor(store: Store, model: Model, provider: SearchProvider, clock: Clock, options = defaults) {
    this.store = store;
    this.model = model;
    this.provider = provider;
    this.clock = clock;
    this.options = options;
  }

  async chat(user: string, input: ChatRequest, trace: string, signal: AbortSignal, update: Progress): Promise<Reply> {
    const started = performance.now();
    const asked = this.clock();
    const zone = timezone(input.timezone);
    const kind = route(input.message);
    const checking = kind === "compare";
    const historic = kind === "history" || checking;
    const window = historic ? historicalWindow(input.message, asked, zone) : null;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.options.turnTimeout)]);
    const timing: Timing = { memory_ms: 0, llm_ms: 0, search_ms: 0, model_calls: 0, search_calls: 0,
      provider_calls: 0, cache_hits: 0, cache_misses: 0, tokens: null };

    const infer = async <T>(operation: () => Promise<{ value: T; tokens?: number }>) => {
      deadline.throwIfAborted();
      const start = performance.now();
      timing.model_calls++;
      try {
        const { value, tokens } = await operation();
        if (tokens !== undefined) timing.tokens = (timing.tokens ?? 0) + tokens;
        return value;
      } finally { timing.llm_ms += performance.now() - start; }
    };

    update("receive_query");
    update("load_context");
    const revision = await this.store.revision(user, input.session_id);
    const requestId = input.request_id ?? null;
    const replay = await this.store.replay(input.session_id, requestId, input.message);
    if (replay) return replay;
    const ctx = await this.store.context(user, input.session_id, window,
      historic && !window ? terms(input.message) : [], { snapshots: checking, memories: kind === "chat" });
    const candidates = window ? ctx.dated : [...new Map([...ctx.recent, ...ctx.related].map(turn => [turn.id, turn])).values()];
    let target = historic ? selectTarget(input.message, candidates,
      Boolean(window)) : undefined;
    const baseline = checking ? selectSnapshot(input.message, input.session_id, ctx, target, Boolean(window)) : undefined;
    if (baseline && (!target || !window) && target?.id !== baseline.id) {
      target = await this.store.turn(user, baseline.id);
    }
    timing.memory_ms += performance.now() - started;
    const hasBaseline = Boolean(target || baseline);
    const baseTime = baseline?.retrieved_at ?? target?.asked_at ?? null;
    const staticRecheck = checking && target && !baseline && freshness(input.message) === "general" &&
      /^(?:explain|define|how does|what is (?:a|an))\b/i.test(target.question) && route(target.question) === "chat";
    const recent = [...ctx.recent].reverse().map(contextTurn);
    const relevantMemories = ctx.memories.filter(memory => overlap(input.message, memory.key + " " + memory.content));
    const activeMemory = (relevantMemories.length ? relevantMemories : canSaveMemory(input.message) ? ctx.memories.slice(0, 8) : [])
      .map(({ id, kind, key, content, observed_at }) => ({ id, kind, key, content, observed_at }));
    const reply: Reply = {
      message_id: randomUUID(), answer: "", timestamp: "", citations: [], web_search_used: false,
      memory_used: false, evidence_mode: "model_knowledge", search_status: "not_used",
      changes: [], baseline_at: checking ? baseTime : null, trace_id: trace, elapsed_ms: 0, timing,
    };
    let snapshot: Snapshot | undefined;
    let memories: MemoryUpdate[] = [];

    update("decide_search");
    if (historic && window && !target) {
      const format = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: zone });
      reply.answer = ctx.dated.length > 1
        ? "I found multiple questions for that time. Which one should I check?\n\n" +
          ctx.dated.slice(0, 5).map(turn => "- " + turn.question).join("\n")
        : "I couldn’t find a matching saved question for that date (" + format.format(new Date(window[0])) + ").";
      reply.evidence_mode = "historical";
      reply.memory_used = ctx.dated.length > 0;
    } else if (kind === "history" || (checking && !hasBaseline)) {
      if (target) {
        reply.citations = historicalCitations(target.response.citations);
        reply.answer = recall(target, this.localDate(target.asked_at, zone));
        reply.memory_used = true;
        reply.evidence_mode = "historical";
      } else {
        reply.answer = checking ? "Which earlier answer should I check? Tell me the topic or when you asked."
          : "I couldn’t find an earlier question to recall. What topic or date should I look for?";
      }
    } else if (staticRecheck && target) {
      update("generate_answer");
      const draft = await infer(() => this.model.chat({
        question: input.message, conversation: [contextTurn(target)], extract_memory: false,
        task: "Re-evaluate the saved general explanation. Correct any error you identify. Use your existing knowledge.",
      }, deadline));
      const answer = modelAnswer(draft.answer);
      if (!answer) throw new ServiceError("model_unavailable", "The model returned an empty reply. Try again.", 503);
      reply.answer = recall(target, this.localDate(target.asked_at, zone)) + "\n\n" + answer;
      reply.memory_used = true;
      reply.evidence_mode = "historical";
    } else if (kind === "search" || checking) {
      const research = await this.research(input.message, checking, asked, baseline, target, ctx, reply,
        deadline, infer, update, zone);
      snapshot = research;
    } else {
      update("generate_answer");
      const draft = await infer(() => this.model.chat({
        question: input.message, local_time: this.localDate(asked.toISOString(), zone), timezone: zone,
        conversation: recent, saved_details: activeMemory, extract_memory: canSaveMemory(input.message),
      }, deadline));
      reply.answer = modelAnswer(draft.answer);
      if (!reply.answer) throw new ServiceError("model_unavailable", "The model returned an empty reply. Try again.", 503);
      memories = remembered(draft.memories, input.message);
      reply.memory_used = Boolean(recent.length || activeMemory.length);
      reply.evidence_mode = reply.memory_used ? "conversation" : "model_knowledge";
    }

    update("persist_memory");
    deadline.throwIfAborted();
    reply.timestamp = this.clock().toISOString();
    reply.elapsed_ms = performance.now() - started;
    const saved = await this.store.save({
      user, session: input.session_id, revision, requestId, question: input.message,
      askedAt: asked.toISOString(), reply, snapshot, memories,
    });
    update("complete");
    return saved;
  }

  private localDate(date: string, zone: string): string {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium", timeStyle: "short", timeZone: zone,
    }).format(new Date(date)) + " (" + zone + ")";
  }

  private async research(
    message: string, checking: boolean, asked: Date, baseline: Snapshot | undefined, target: Turn | undefined,
    ctx: Context, reply: Reply, signal: AbortSignal,
    infer: <T>(operation: () => Promise<{ value: T; tokens?: number }>) => Promise<T>,
    update: Progress, zone: string,
  ): Promise<Snapshot | undefined> {
    const prior = checking && target ? contextTurn(target) : undefined;
    const publicQuery = baseline?.search_query;
    const force = checking || forceSearch(message);
    const ttl = this.options.ttl[freshness(message + " " + (publicQuery ?? ""))];
    const budget = this.options.searchCalls;
    const exact = baseline && freshness(baseline.question) !== "market" &&
      !terms(message).length && !/\b(pricing|prices|product updates)\b/i.test(message) &&
      new Set(baseline.claims.map(claim => claim.subject.toLowerCase())).size <= 1 && safeQuery(publicQuery ?? "");
    const plan = exact && publicQuery
      ? { query: publicQuery, max_results: this.options.searchResults, additional_queries: [] }
      : await infer(() => this.model.plan({
        question: message, prior_public_query: publicQuery, earlier_turn: prior,
        conversation: !prior && (refersBack.test(message) || checking)
          ? ctx.recent.slice(0, 5).reverse().map(contextTurn) : [],
        prior_subjects: baseline?.claims.map(claim => ({ subject: claim.subject, attribute: claim.attribute, scope: claim.scope })),
        budget, today: this.localDate(asked.toISOString(), zone),
      }, signal));

    const scopedMessage = checking && !terms(message).length && baseline ? baseline.question : message;
    const queries = queryTasks(plan, scopedMessage, budget);
    if (!queries.length) throw new ServiceError("invalid_search_plan", "Echo couldn’t form a public search query.", 503);
    update("execute_search");
    const searchStart = performance.now();
    const count = Math.min(plan.max_results, this.options.searchResults);
    const keys = queries.map(({ query }) => query.toLowerCase().replace(/\s+/g, " ") + "\n" + count);
    const entries = keys.map(key => this.cache.get(key));
    const allCached = !force && entries.every(entry => entry && entry.until > asked.getTime() &&
      entry.hits.every(hit => Date.parse(hit.retrieved_at) + ttl > asked.getTime()));
    const batches = await Promise.all(queries.map(async ({ query, domain }, index) => {
      const key = keys[index];
      const cached = entries[index];
      if (allCached && cached) {
        reply.timing.cache_hits++;
        return { hits: cached.hits, cached: true, failed: false };
      }
      reply.timing.cache_misses++;
      reply.timing.search_calls++;
      reply.timing.provider_calls++;
      try {
        const hits = validHits(await this.provider.search(query, count, signal)).filter(hit => {
          if (!domain) return true;
          const host = publicUrl(hit.url)?.hostname ?? "";
          return host === domain || host.endsWith("." + domain);
        }).slice(0, count);
        if (hits.length && this.options.cacheSize && ttl) {
          this.cache.delete(key);
          this.cache.set(key, { hits, until: this.clock().getTime() + ttl });
          while (this.cache.size > this.options.cacheSize) this.cache.delete(this.cache.keys().next().value!);
        }
        return { hits, cached: false, failed: false };
      } catch {
        return { hits: [], cached: false, failed: true };
      }
    }));
    reply.timing.search_ms += performance.now() - searchStart;
    signal.throwIfAborted();
    reply.web_search_used = reply.timing.search_calls > 0;
    const unique = new Map<string, SearchHit>();
    for (const batch of batches) {
      for (const hit of batch.hits) {
        // The same page may appear with different excerpts. Keep both for the comparison.
        unique.set(hit.url + "\n" + hit.snippet, hit);
      }
    }
    const sources = [...unique.values()];
    const cached = batches.every(batch => batch.cached);
    const partial = batches.some(batch => batch.failed || !batch.hits.length);
    reply.search_status = sources.length ? (cached ? "cached" : "live")
      : batches.some(batch => batch.failed) ? "unavailable" : "empty";
    reply.memory_used = checking ? Boolean(prior || baseline) : Boolean(refersBack.test(message) && ctx.recent.length);

    const archival = checking && target ? historicalCitations(target.response.citations) : [];
    const prefix = checking && target && /\bwhat (?:did|had) i ask\b/i.test(message)
      ? recall(target, this.localDate(target.asked_at, zone)) + "\n\n"
      : "";
    const baselineNote = checking && reply.baseline_at
      ? "\n\nI used the check from " + this.localDate(reply.baseline_at, zone) + " as the reference." : "";
    let claims: Snapshot["claims"] = [];
    let citations: Reply["citations"] = [];
    if (sources.length) {
      update("generate_answer");
      const draft = await infer(() => this.model.research({
        question: message, earlier_turn: prior, prior_claims: baseline?.claims ?? [],
        baseline_at: reply.baseline_at, timezone: zone, today: asked.toISOString(),
        sources: sources.map((source, index) => ({ id: "R" + (index + 1), ...source })),
      }, signal));
      update("validate_response");
      ({ citations, claims } = ground(draft, sources, cached));
      if (!citations.length) reply.search_status = "unsupported";
    }

    reply.citations = [...citations, ...archival];
    if (checking) {
      reply.changes = compare(baseline, claims, sources, target?.asked_at);
      // A partial search cannot establish a change: the failed query may contain competing evidence.
      if (partial) reply.changes = reply.changes.map(change => change.kind === "changed"
        ? { ...change, kind: "insufficient" } : change);
      reply.citations = citeComparison(reply.changes, reply.citations, baseline, sources);
      const comparison = summarizeComparison(reply.changes, reply.citations);
      const evidence = citations.length && reply.changes.every(change => ["insufficient", "now_unverified"].includes(change.kind))
        ? "\n\nHere’s what I found in the fresh search:\n\n" + renderCitations(citations) : "";
      const missing = !baseline?.claims.length ? "I don’t have comparable evidence saved from the earlier answer.\n\n" : "";
      const failed = reply.search_status === "unavailable" ? "The web search didn’t complete. " : "";
      reply.answer = prefix + failed + missing + comparison + evidence + baselineNote;
    } else if (citations.length) {
      const conflicts = compare(undefined, claims, sources).filter(change => change.kind === "conflicting");
      reply.changes = conflicts;
      reply.answer = (conflicts.length ? summarizeComparison(conflicts, citations) + "\n\n" : "") +
        renderCitations(citations) + (cached ? "\n\nI used saved search results for this answer." : "");
    } else {
      reply.answer = reply.search_status === "unavailable"
        ? "I couldn’t complete the web search. Try again in a moment."
        : "I couldn’t verify an answer from the sources I found.";
    }
    if (partial && citations.length) reply.answer += "\n\nPart of the search didn’t return usable evidence.";
    reply.evidence_mode = citations.length ? (cached ? "cached_snippets" : "live_snippets") : "insufficient";
    if (!citations.length || cached || (checking && !claims.length)) return;
    const latest = new Date(Math.max(...sources.map(source => Date.parse(source.retrieved_at)))).toISOString();
    const topic = baseline?.topic_key ?? (terms(queries.map(item => item.query).join(" ")).join(" ") || queries[0].query).slice(0, 180);
    return {
      id: reply.message_id, user_id: "", session_id: "", question: message, topic_key: topic, search_query: queries[0].query,
      asked_at: asked.toISOString(), retrieved_at: latest, expires_at: new Date(Date.parse(latest) + ttl).toISOString(),
      answer_summary: reply.answer, claims, sources,
    };
  }
}
