# Echo design

## Problem and philosophy

A previous answer is a dated observation, not an assertion about the present. A follow-up such as “Is that still accurate?” has three separate jobs: resolve “that,” obtain new evidence, and decide whether the old and new evidence answer the same factual question. Echo records the steps separately so a failed lookup cannot be mistaken for an unchanged fact. It favors one model call for a simple question and gives application code ownership of when a search is warranted and what gets persisted.

## Components and lifecycle

~~~mermaid
flowchart LR
  C[REST or SSE client] --> A[FastAPI routes and demo identity]
  A --> O[ChatAgent state machine]
  O --> M[Context and temporal memory]
  M --> D[(SQLite or PostgreSQL)]
  O --> L[OpenAI adapter]
  O --> F[Freshness policy and cache]
  F --> T[Tavily Search adapter]
  O --> G[Grounding and claim comparison]
  G --> O
  O --> D
  O --> P[Structured timings and trace ID]
~~~

~~~mermaid
stateDiagram-v2
  [*] --> receive_query
  receive_query --> load_context
  load_context --> complete: idempotent replay
  load_context --> decide_search
  decide_search --> execute_search: evidence needed
  decide_search --> generate_answer: no search or clarification
  execute_search --> generate_answer
  generate_answer --> validate_response
  validate_response --> persist_memory
  persist_memory --> complete
  complete --> [*]
~~~

A turn reads a bounded context and the session revision in a short database session. It releases that connection before inference or search. It resolves the referent, obtains evidence when needed, and validates the draft. A short transaction compares and increments the session revision, then writes the completed turn and associated memory or snapshot. If the revision changed, the response is replayed by request ID when possible; otherwise the caller retries against the updated conversation. Errors before commit leave no half turn. SSE observes the same state machine; its successful completion follows commit.

### Frontend integration

The Next.js client uses a same-origin rewrite for FastAPI REST and SSE. This keeps the browser on one origin and leaves the backend's demo identity and CORS behavior unchanged. The client keeps the selected session ID locally and loads its messages from the backend. It renders streamed fragments as a preview and uses the completion payload for the saved reply. After an interruption it can resend the same request ID. The inspector uses per-reply response fields from both the stream and stored history.

### Routing and the only tool

Rules recognize general questions, freshness cues, contextual follow-ups, explicit recall, and comparison. For “Has anything changed?” immediately after research, the adjacent snapshot supplies the baseline. Explicit topic matches use ranked candidates; ties and stale conversational referents can use one structured, tool-free resolver call. The resolver can only select a supplied snapshot ID or, for current-fact follow-ups without research, suggest a short public subject grounded in a prior user question. If the system cannot establish a comparison baseline, it asks for clarification. Ordinary recall and personal plan questions do not search.

A search turn gives the model exactly one strict function, `web_search(query, max_results)`, to formulate the public query. The application validates the name, argument types, length, result limit, and the number of calls. It rejects unsolicited tools and multiple calls in a reply. An empty result can trigger one distinct reformulation within the configured budget (at most two); a provider error ends search for the turn. Separate synthesis receives bounded excerpts keyed by application IDs, with no tools enabled. Context loading, caching, storage and comparison are internal services; the model cannot call a database, a browser, or a general HTTP client.

## Memory and schema

| Table | What it preserves |
| --- | --- |
| `sessions` | Session UUID, demo owner, title, UTC creation time, and integer revision. Indexed by owner and time. |
| `turns` | Two stable message UUIDs, ordered turn number, separate asked/answered times, user text, and the complete assistant response (sources, changes, evidence mode, and timings). Unique turn sequence and optional request ID per session. Owner is inherited from the session. |
| `memories` | Explicit user quote in a typed slot (goal, preference, project, plan, commitment); observed/created UTC times, source user message ID, and supersession link. |
| `snapshots` | Append-only research record linked to the assistant turn; original question, normalized topic, public query, UTC ask/retrieval/expiry, answer summary, claims, and provider excerpts. Indexed by owner, session, topic and time. |

UTC conversion is explicit at the SQLAlchemy boundary, including after a SQLite round trip. Historical recall uses UTC dates for “last week” (the previous Monday–Sunday), “last month,” “yesterday,” and “N days ago.” With one matching saved turn, Echo quotes the requested speaker and the original timestamp. Citations from an archived assistant reply are marked historical. With several candidates, the model receives only the selected history and is told to report it as recall.

Retrieval combines the last few turns with FTS5 candidates and ranks them using topic term coverage, session locality for research, and recency. FTS5 tables and triggers are installed by an optional SQLite-only migration. Other configurations rank a capped recent set; they can miss older material. The agent also selects up to eight relevant active semantic memories. The model sees distinct fields for the user’s text, the assistant’s reply, and their timestamps. These are separate from external evidence.

The answer schema can propose semantic memories on explicit self-reports. The server requires a verbatim span of the current user message and a normalized typed key. It will not overwrite a different active quote unless the draft points to the same active memory seen during retrieval. A unique active-slot constraint and conditional update protect concurrent writes; superseded rows and their source messages remain available. The extraction records what the user said; it neither verifies their plans nor infers personal attributes from web data.

## Freshness, grounding, and changes

Default TTLs are 15 minutes for news/weather, 1 hour for prices/markets, 6 hours for releases, and 24 hours for other research. All can be set in seconds in `.env`. An explicit current check, explicit search request, or comparison bypasses both the in-process LRU and durable snapshot reuse. Implicit research may reuse an unexpired snapshot for the same normalized standalone question or an LRU entry for the same owner, normalized tool query, result cap, and volatility. Cache hits retain their original retrieval time and cannot create a new live snapshot. Failures and empty batches are not cached. A provider call in the current turn does not guarantee that the underlying pages were fetched or published in the current turn.

The source pool maps short application IDs to Tavily results. Only HTTP(S) provider URLs are eligible. The draft selects exact quotations from those excerpts. Validation checks the ID and quotation, and the renderer uses the approved quote and provider URL rather than model-written web prose or links. Publication and retrieval times remain separate. For extracted facts, the literal subject and value must appear in the witness quote. This constrains attribution; it does not prove that the quote is authoritative, current, relevant, or semantically sufficient for the proposed attribute.

A structured claim holds `subject`, `attribute`, `value`, `observed_at`, `source_url`, witness quote, and an evidence status of `snippet_supported`. The model proposes keys and values and is asked to carry forward compatible keys only for the same entity, units and scope. The comparator groups by normalized subject and attribute and compares distinct normalized values. It reports changed, unchanged, new, now unverified, conflicting, or insufficient. A current conflict prevents a single-value conclusion. A missing current claim becomes unverified, and a lack of comparable keys becomes insufficient. The result and both sides' claim records are saved in the turn; old snapshots are never updated in place.

## Speed and failure behavior

Stable requests use one inference and no tool. A normal research turn uses one function call and one synthesis; only an ambiguous contextual turn or empty first result adds work. Both adapters reuse async HTTP clients. Context size, tool count, search results, model output, and timeout budgets are bounded. Logs contain a trace ID, state, outcome, total elapsed time, memory/search/model timings, provider and cache counts, and token usage when reported. The response duration is measured before the commit; logs include the commit. No text, snippets, API keys, or request bodies are written to Echo logs.

| Condition | Behavior |
| --- | --- |
| Missing model key, refusal, invalid structured reply, or model deadline | Sanitized 503 for turns requiring inference; no turn stored. |
| Tavily outage, timeout, empty results, or unsupported citations | The current check is inconclusive. A previous snapshot remains historical. |
| Overall turn deadline | Sanitized 504 before a response. Use the same request ID to check whether commit already succeeded. |
| Storage failure, malformed input, or unknown session | Sanitized 503, 422, or 404 respectively. |
| Concurrent same-session turn or idempotency conflict | A completed replay returns the original result; conflicting writes return 409. |

## Security and limits

Run this demo on loopback. There is no authentication, authorization beyond the configured single identity, rate limiting, deletion flow, or encrypted storage policy. All queries use SQLAlchemy binding; the SQLite FTS query is bound and its search tokens are derived locally. The OpenAI call is made with `store=false`, which is not a guarantee about provider retention. The model receives the current request and bounded context. The tool planner never sees source snippets or semantic memory, and grounded synthesis has no tools. Snippets are treated as untrusted text. These controls reduce injection exposure but do not make model judgment or returned web content trustworthy. The app does not fetch cited pages. Render user text and excerpts as text in a client, not as trusted HTML.

The routing rules are English-focused and can miss current facts phrased indirectly. Structured extraction can miss changes, conflate units, or choose irrelevant excerpts. Related wording can fragment topic keys, and identical values cannot prove continuity between checks. There is no source credibility model or article-level entailment verification. The cache is process-local, a retry can repeat external calls before a turn commits, and SQLite permits only one writer at a time. PostgreSQL uses the same relational schema and query fallback; see the verification notes for what was exercised. SSE streams progress and validated fragments; this delays the first answer fragment compared with raw model token streaming.

## Tradeoffs, evaluation, and next steps

Explicit orchestration makes the routing and comparison policy reviewable and lets tests assert calls, evidence labels, and timestamps without a provider. A free-form tool loop would be more flexible but could spend an unpredictable number of requests. Embeddings could improve recall, but indexed lexical candidates and conversation-aware resolution are easier to audit for the initial corpus. Exact excerpts are less polished than unrestricted synthesis, but they constrain the evidence presented to the user and make citation checks mechanical. Full-page fetching would exceed the single-tool surface.

Tests use a fixed clock, scripted model/search responses, and actual database migrations. They exercise general answers, provider contracts, recall, corrections, freshness, conflicting claims, errors, concurrency, persistence across restarts, and SSE completion. The eight cases in `evals/cases.json` specify behavioral expectations; the runner measures actual local HTTP turn latency and tool and provider usage. These fixtures evaluate policy and plumbing, not live search quality or model factual accuracy.

Next, collect labeled temporal examples for routing and comparison errors. Then add a PostgreSQL search index or embeddings behind the existing candidate interface, better entity and unit normalization, source quality checks within the existing tool, real-provider regression runs, and authentication with deletion and retention controls before exposing a shared deployment.

Provider contracts: [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat) and [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search).

