# Verification

## Release checks

| Check | Result |
| --- | --- |
| Python formatting and lint | Ruff passed. |
| Backend automated tests | 41 passed. Coverage includes routing, citations, memory, comparisons, persistence, SSE, provider contracts, and isolation between browser cookies. |
| Deterministic evaluation | 8 of 8 scenarios passed over 14 turns, with 7 search tool calls and 7 fake provider calls. |
| SQLite | Migration upgrade, schema check, downgrade, and re-upgrade passed on a disposable database. |
| PostgreSQL | Migration upgrade, schema check, downgrade, and re-upgrade passed on PostgreSQL 18. The API verified cross-session memory correction, history, and persistence after restarting the application. |
| Frontend | TypeScript, ESLint, all 12 automated tests, and the Next.js production build passed. |
| Browser | 29 checks passed in Edge against the production build with fixture providers. They cover session switching, submission, streaming and retry, the Inspector, evidence, saved memory, reduced motion, and widths from 375 to 1440 px. |
| Render Blueprint | Passed Render’s public JSON Schema validation. |
| Publication scan | Gitleaks scanned Git history. A separate check compared locally configured provider keys against the tracked files and reachable historical blobs. Neither check found a credential. |

## Live provider smoke tests

Local smoke tests used real Groq and Tavily calls and an isolated database. Groq returned a streamed general answer and a dated recall. Tavily returned live citations that passed Echo’s source checks. A fresh recheck found the historical baseline but did not return comparable evidence, so Echo reported the comparison as insufficient. In a separate focused run, Groq saved a plan, superseded it in a new conversation, and recalled the corrected plan. The initial combined run encountered transient inference errors during the memory steps.

## Evaluation method

Run `python -m evals.run` from the repository root. The runner exercises HTTP turns against real migrated storage with a fixed clock and deterministic provider responses. It checks policy and evidence outcomes, counts model-directed search calls and provider requests, and measures p50 and p95 turn latency. Those timings describe the local fixture path and exclude live provider latency. Live search results and model outputs can vary between runs.
