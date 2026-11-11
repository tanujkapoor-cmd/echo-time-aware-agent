# Minimi challenge evaluation

Audited on 11 November 2026 against the requirements in the challenge brief. The submitted runtime starts both the UI and API on Node.js. The three historical scenarios use controlled search excerpts and a clock, while the live probe uses Groq and Tavily.

## Verification matrix

| Requirement | Status | Evidence | Fix Applied |
| --- | --- | --- | --- |
| JavaScript or TypeScript on Node.js | PASS | `npm run dev` launches Next.js and the Fastify API from the root. The API identifies its runtime as Node on the health endpoint. | Ported chat, streaming, search, persistence and identity from FastAPI. |
| Root installation and startup | PASS | A fresh worktree installed via `npm install`. The workspace and proxied health endpoint each returned HTTP 200 after `npm run dev`. | Added root npm workspace and dev scripts. Fixed Turbopack resolution for dependencies hoisted to the root. |
| Exactly one agent tool | PASS | `providers.test.ts` checks the outgoing request and rejects other tool names. Groq returned a valid live `web_search` plan. Answer calls have no tools. | Added one allowlisted tool and a server-enforced Tavily request budget. |
| Both provider adapters | PARTIAL | Mocked Groq and OpenAI Chat Completions contracts pass. The live Groq plan and replies worked. The configured OpenAI account returned HTTP 429 with `credit_balance_exhausted`. | Distinguished exhausted quota from temporary throttling and invalid credentials. |
| Persistent, dated memory and isolation | PASS | Node tests cover SQLite reopen, PostgreSQL reopen, dated retrieval beyond the recent-turn window, explicit corrections, replay and signed browser isolation. | Preserved the table layout and cookie signature. Added browser-timezone date windows and retained original turns and evidence snapshots. |
| A. Monday CRM shortlist | PASS | Fixture covers all five named products, 20-person context, two current searches, a scoped price change, a dated vendor update, competing prices and an annual/monthly mismatch. The recheck uses a new session after reopen. | Scoped comparable prices and preserved the earlier public topics for the recheck. |
| B. 3 November historical question | PASS | Fixture retrieves the actual question and answer across sessions after reopen. The saved UTC timestamp falls on 3 November locally. The suite also covers a missing date and a stable explanation that needs no search. | Added date-window lookup and deterministic recall. |
| C. Last Tuesday PostgreSQL hosting | PASS | Fixture reopens a previous session’s Render and Neon research, compares the matching plan, and leaves a different billing cadence unconfirmed. A separate test verifies the missing-evidence path. | Scoped price comparisons and made missing history explicit. |
| Live search and citations | PARTIAL | Live Python answer and recheck cite python.org, with separate historical and current citations. A later PostgreSQL probe retrieved both vendor domains and found Neon billing terms. A like-for-like live pricing comparison remained inconclusive. | Added per-domain searches for explicitly named pricing pages. Separated billing excerpts from comparable claims and rejected capacity-only quotes in those requests. |
| Speed and caching | PARTIAL | Live timings below. Fixtures verify one inference for normal chat, zero for exact recall, cache reuse, parallel query budgets and forced refresh. | Removed snapshot reads from ordinary chat. Reused earlier public queries for simple rechecks and ran independent searches in parallel. |
| Conversational quality | PASS | In the browser, a streamed follow-up recovered the 15-minute feed interval. The Inspector showed context use and zero web searches. Fixtures cover correction, previous answers, ambiguous history and unnecessary searches. | Preserved roles and relevant context, separated source extraction from direct replies, and formatted uncertainty in the reply. |
| Reliability and injection handling | PASS | Tests cover invalid credentials, quota, provider outage, timeouts, empty/malformed model replies, invalid tool calls, injected snippets, concurrent writes and duplicate requests. | Parse structured answer content only, check quotes against retrieval, and commit the turn and snapshot atomically. |
| One-page design, README and env example | PASS | [DESIGN.md](../DESIGN.md) explains architecture, alternatives, latency, evidence and next steps. The [README](../README.md) and [example env](../.env.example) document root startup and provider keys. The UI is unchanged from the product-tour captures. | Corrected filename case and replaced the Python startup instructions. |
| Public GitHub and credentials | PASS | GitHub reports the Echo repository as public. Only the two env examples are tracked. No provider key prefixes with credential-length values were found in reachable Git history. | Kept API keys in backend environment configuration. |
| Existing hosted Node cutover | NOT TESTED | The Render Blueprint validates against Render’s public schema. The live API returned the original FastAPI OpenAPI document during the audit. | Updated the Blueprint to run the Node API against the existing schema. The hosted preview’s runtime was outside the local test result. |

The three scenario passes above cover the specified behavior under controlled evidence. Historical fixture amounts and update text are test data. They do not describe current vendor prices.

## Commands and results

- `npm install` and `npm run dev` on a clean worktree. Verified the page and the same-origin API health response. Used alternate ports because the original development processes were active.
- `npm test` passed 24 Node API tests and 12 frontend tests. The optional PostgreSQL test is skipped by default.
- `npm run eval` passed all five cases, including the three challenge scenarios.
- The PostgreSQL integration test passed against a disposable PostgreSQL 18.6 database initialized using the original Alembic schema. The SQLite compatibility test opened pre-migration-format rows and saved a new reply to the same file.
- `npm run typecheck`, `npm run lint` and `npm run build` passed. A separate API suite run on Node 22.18.0 verified the documented minimum.
- `npm audit --omit=dev` reported zero vulnerabilities. The full install reported seven moderate findings in the development dependency tree at the time of the audit.

## Live performance

Local HTTP requests used real Groq inference and Tavily search, with six seconds between turns to reduce provider throttling. The delay is outside the measured request. This is a small warm sample. The web-search column measures the parallel search phase, and the model column sums inference calls within a turn.

| Metric | Sample count | p50 | p95 |
| --- | ---: | ---: | ---: |
| End-to-end HTTP | 10 | 804 ms | 4,287 ms |
| Model inference | 8 | 821 ms | 1,218 ms |
| Web-search phase | 3 | 1,941 ms | 3,412 ms |
| Memory and context loading | 10 | 1 ms | 8 ms |

Nine of the ten live checks met their assertions. The pricing case returned insufficient evidence and did not claim a change. Three Tavily calls were made across the ten turns. The cited Python answer took 4,287 ms. Its recheck reused the prior query and took 2,522 ms with one inference call and one fresh search. On the cached fixture, an eligible repeated search had one cache hit and zero Tavily calls, while the explicit recheck made a fresh call.

## Failures and remaining limits

- The original FastAPI app passed 44 legacy tests and eight legacy evals, but failed the challenge’s Node runtime and root startup requirements. It also lacked the specified timezone date forms. The original code remains for legacy schema verification and the hosted preview.
- The original comparator reported a false Node.js LTS change after comparing a full version from the official site with a major line from a different source. A regression fixture now verifies that neither granularity nor cross-page disagreement can produce that verdict.
- The historical cause of every earlier `print 42` reply cannot be reconstructed from the available traces. The new adapter reads the structured reply field and rejects malformed completions. A fixture puts `print 42` in the reasoning channel and verifies that the actual answer is returned.
- The first unpaced Groq run hit provider throttling, and one subsequent pricing search timed out. The measured run completed all ten HTTP requests. A targeted probe found that the model sometimes omitted one vendor or returned a capacity-only quote. The API now searches both named domains within the budget and reports missing pricing evidence explicitly.
- Snippets can omit a currency, the billing basis or a whole vendor. Echo can still cite a relevant excerpt, but it needs comparable evidence to assert a change. Source preference is a planning heuristic. The API checks excerpts against provider results and does not independently establish publisher authority.
- Topic lookup and prompt history are bounded, and date parsing covers English forms. Very long histories, ambiguous references, or a new browser identity can reduce recall. These tradeoffs are described in [DESIGN.md](../DESIGN.md).
