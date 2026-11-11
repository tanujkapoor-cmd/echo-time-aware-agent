# Echo design

“Has anything changed?” is the question I designed Echo around. A useful answer has to find what the user asked, recover what Echo knew at the time, and check whether today’s evidence supports the same claim. A chat history gives Echo the first two pieces. It takes a fresh lookup and a comparable claim to answer the third.

The challenge asks for a fast, accurate agent with one tool that remembers what you asked and when. Echo exposes one function to the model, `web_search`, backed by Tavily. Retrieval, persistence, caching, and claim comparison run inside the application. Keeping those decisions in code made the search budget and failure behavior testable.

## One turn

~~~mermaid
flowchart LR
  U[Browser workspace] -->|REST and SSE| N[Next.js proxy]
  N --> A[FastAPI routes]
  A --> C[ChatAgent]
  C --> R[Routing and context]
  R -->|Bounded retrieval| D[(SQLite or PostgreSQL)]
  C --> M[Groq or OpenAI adapter]
  C -->|web_search| T[Tavily]
  C --> E[Evidence validation and comparison]
  E -->|Completed turn, memory and snapshots| D
  E -->|Answer, sources and trace| A
~~~

1. **Load context.** FastAPI resolves the browser identity and the conversation. The agent reads a bounded set of messages, active memories, candidate research snapshots, and the session revision. It releases the database connection before provider calls.
2. **Decide whether to search.** General questions, personal recall, and dated history follow a local route. Current facts, explicit lookups, and comparisons can search. A contextual question can use a tool-free resolver to choose a supplied snapshot or identify a public subject grounded in the conversation.
3. **Get evidence and draft.** For a search, the model proposes one function call with a bounded query and result count. Echo validates it before calling Tavily. One distinct reformulation is allowed after an empty result, for a maximum of two searches. Synthesis receives bounded excerpts and can cite them by ID.
4. **Validate and save.** The agent checks the draft, compares claims when relevant, and writes the completed turn and any new records in a short transaction. The session revision detects concurrent writes. The same request ID can replay an already committed answer, including its trace.
5. **Return progress and the saved answer.** Server-sent events carry progress and heartbeats during processing. After validation and commit, Echo sends source metadata, answer fragments, and the completed reply. This gives the user early feedback while keeping the visible answer tied to the stored result.

The Python backend uses FastAPI, Pydantic, SQLAlchemy, and Alembic. One Chat Completions adapter supports Groq and OpenAI. A normal chat takes one model call. Research typically takes one query-planning call and one synthesis call. The tool planner receives the public query context and the synthesis step receives excerpts, which limits what either step can do.

## What Echo remembers

| Record | What it is for |
| --- | --- |
| `sessions` and `turns` | The question and answer as they appeared, separate UTC timestamps, citations, changes, trace metadata, and the order of completed turns. |
| `memories` | Explicit details supplied by the user, such as a plan or preference. Each entry keeps the quoted span, typed key, source message, and observation and save times. |
| `snapshots` | Research that can be recalled or compared later. A snapshot records the public query, retrieval and expiry times, source excerpts, and validated claims. |

These records answer different questions. “What did I ask last week?” needs the original message and date. “When is my interview?” needs the active plan. “Is the latest release still the same?” needs the previous evidence and a new observation.

SQLite uses FTS5 when available, together with recent turns and topic matching. PostgreSQL and SQLite without FTS5 rank a bounded recent set. Historical queries resolve relative dates in UTC. Semantic retrieval selects up to eight active memories. When the user corrects a detail, the replacement must quote the new message and point to the active entry seen during retrieval. A conditional update and unique active slot prevent concurrent corrections from silently overwriting each other. The older entry remains available in the timeline.

## Deciding what changed

For a follow-up immediately after research, the adjacent snapshot supplies the baseline. Other questions use ranked topic candidates and can ask for clarification when the subject remains ambiguous. A fresh recheck always goes back to Tavily. Implicit research can reuse an unexpired snapshot or a process-local cache entry. Default freshness windows range from 15 minutes for news and weather to 24 hours for general research. Cached excerpts retain their original retrieval time.

Echo accepts citations only from the returned HTTP(S) results. The draft supplies a source ID and an exact quote. The backend checks both, and uses the provider URL when rendering the answer. An extracted claim also needs its subject and value in the witness quote. Publication and retrieval times are shown separately. Retrieval time tells us when Echo saw the excerpt, while the publication date, when available, tells us when the source says it was published.

For comparison, Echo groups claims by normalized subject and attribute, then compares the values within each group. The result can be changed, unchanged, new, unverified, conflicting, or insufficient. If a current source cannot establish a comparable value, Echo can still show the old observation and explain the gap. Quote matching constrains attribution. It cannot settle source credibility or prove that differently worded claims refer to the same scope and units.

## What the user can inspect

The Next.js workspace gives the user a conversation sidebar, a central composer, and an Agent Inspector. A same-origin rewrite carries REST and SSE through the frontend domain. The composer keeps typing state local, and the transcript reconciles pending and saved replies by stable keys.

The Inspector distinguishes a live search from a cache hit, reports whether context was used, and shows response time, search calls, cited excerpts, and the trace ID. Comparison cards keep earlier and current claims side by side. Saved memory has its own timeline because the API reports context usage at the reply level and does not provide a record-by-record citation for memory.

## Where Echo fails and how I check it

A missing model key, provider failure, or unusable structured reply produces a sanitized error. Failed or empty searches and unsupported excerpts produce an inconclusive current result. A network interruption lets the composer offer a retry with the same request ID. The overall deadline bounds a turn. Echo logs trace IDs, phase timings, search counts, and outcomes so I can investigate failures without logging prompts, excerpts, or credentials.

Backend tests use a fixed clock, scripted providers, and real migrations. They cover routing, historical recall, corrections, conflicting evidence, ownership, concurrent writes, restart persistence, and SSE completion. The fixture suite in `evals/cases.json` checks outcomes and counts provider calls. Its timing measures the local path. Frontend tests cover API parsing and streaming, and browser checks exercise the composer, history, source disclosures, Inspector, and responsive layout. The live provider checks and their limits are recorded in [VERIFICATION.md](VERIFICATION.md).

## Tradeoffs and next steps

I chose an explicit state machine so a test can tell whether a question searched, which baseline it used, and what got stored. An open-ended tool loop would make the call budget harder to predict. I kept lexical retrieval and snippet evidence because they are easy to inspect end to end. The cost is weaker recall for old or loosely related messages, and weaker grounding when the useful context lives outside a snippet.

The public demo uses a signed browser cookie and PostgreSQL. Clearing the cookie loses access to that browser’s history. Account recovery, deletion controls, and application-level rate limiting remain open. Provider quotas, cold starts, and the bounded PostgreSQL retrieval path affect the demo. The free Render database has a finite retention window.

I would start the next pass with a labeled set of real temporal follow-ups and provider failures. That would give me a way to compare retrieval changes before adding an index or embeddings. I would also tighten entity and unit matching, surface why a comparison lacks evidence, and add account-based access and retention controls before broader use.
