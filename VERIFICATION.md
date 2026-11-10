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

