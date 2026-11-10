# Verification

Executed on Python 3.12 on Windows from the Echo project root:

| Check | Result |
| --- | --- |
| `python -m ruff format --check .` and `python -m ruff check .` | Passed. |
| `python -m pytest -q` | 37 passed. Includes both provider HTTP contracts via mock transports, migration-backed API tests, restart persistence, comparison, corrections, and SSE. |
| SQLite: `alembic upgrade head`, `alembic check`, `alembic downgrade base`, `alembic upgrade head` | Passed on a disposable database. |
| Uvicorn loopback smoke test | Startup, health, OpenAPI, session creation/listing, empty message history, and the sanitized missing-key chat response worked over HTTP. |
| `python -m evals.run` | 8 of 8 fixture scenarios passed over 14 chat turns, with 7 search tool calls and 7 fake provider calls. |
| PostgreSQL: `alembic upgrade head --sql` | PostgreSQL DDL generated successfully, with timezone-aware timestamps and no SQLite-specific FTS statements. |

The measured fixture run recorded **14.57 ms p50** and **18.86 ms p95** for local in-process HTTP turns. Inference and search used deterministic fixtures; these figures do not measure provider latency or factual accuracy.

A live OpenAI/Tavily smoke test was not run because the API keys were not configured. PostgreSQL DDL was checked offline; no live PostgreSQL server was available.

## Frontend

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint -- --max-warnings 0`, and `npm run build` | Passed on Node.js 24. |
| `npm test` | 11 passed. Covers API errors and pagination, fragmented UTF-8 and SSE frames, terminal errors, interrupted streams, and the JSON fallback. |
| Next.js development server and real FastAPI backend | Verified same-origin health and session creation, session selection, and the missing OpenAI key error from the SSE endpoint. |
| Playwright with fixture providers | Verified successful reply display, citations, change metadata, conversation switching and reload, Markdown code blocks, and cancel/retry with the same request ID. The fixture server used Echo's FastAPI endpoints with deterministic model and search adapters. |
| Responsive browser check | Passed at 1440px and 390px. Conversation and inspector disclosures worked on mobile without horizontal overflow. |

OpenAI and Tavily credentials were unavailable. Successful chat, search, and change comparison were verified with fixture providers.

