# Echo

**A time-aware AI chat agent that remembers your questions and checks what has changed.**

[Live demo](https://echo-time-aware-agent.vercel.app/) · [Feature walkthrough](docs/feature-walkthrough.md) · [Technical design](design.md) · [Verification](VERIFICATION.md)

## Overview

Echo was built for the minimi engineering challenge. Ask a question, follow up without repeating the setup, or come back later to check whether an earlier answer still holds. Echo keeps conversation history and dated research so you can see what it checked and when.

## Key features

- **Quick replies.** Everyday questions go straight to the language model. Echo uses Tavily when a question needs current information.
- **Follow-ups that carry context.** Echo saves each turn and can use details from earlier messages in the same conversation. You can ask “When should I label the data as stale?” without restating which data feed you mean.
- **Temporal memory.** Echo records when you asked and when it retrieved evidence. On a recheck, it compares the saved result with fresh sources and flags conflicts or gaps in the evidence.
- **Grounded answers.** Citations link current claims to their sources. The supporting excerpts are available in the Agent Inspector.
- **Inspectable replies.** Open the Agent Inspector to see whether Echo used search or memory, how long the reply took, and which sources it used.

## Product tour

### Landing page

![Echo's welcome screen with a message composer, three suggested prompts, and a conversation sidebar](docs/images/landing-page.webp)

*The welcome screen offers prompts for a current fact, a memory question, or a general topic.*

### Chat in action

![Echo explaining binary search with a short worked example](docs/images/chat-response.webp)

*Echo answers a general question about binary search directly from the model.*

### Context-aware follow-up

![Echo uses the earlier 15-minute transit feed interval to answer when the data becomes stale](docs/images/context-followup.webp)

*Echo carries the earlier 15-minute refresh interval into the follow-up and marks the reply “Context used.”*

### Temporal comparison

![Echo rechecks the Python release, cites fresh results, and reports that it could not verify a change](docs/images/temporal-comparison.webp)

*Echo rechecks the Python release, cites the latest search result, and gives the time of the earlier check. In this run it couldn’t verify a change.*

### Agent Inspector

![Agent Inspector showing search activity, memory use, source citations, and the earlier check's timestamp](docs/images/agent-inspector.webp)

*The Inspector shows that the recheck used search and memory, plus the earlier retrieval time, source details, and trace ID.*

## How Echo works

1. **Load context.** The FastAPI backend retrieves recent turns, relevant saved details, and earlier research for the conversation.
2. **Route the question.** The language model answers general questions directly. Questions that need current evidence can use Tavily, Echo’s web search tool.
3. **Check the evidence.** Echo validates source excerpts, attaches citations, and compares matching claims with the earlier research when the user asks for a recheck.
4. **Save and stream.** Echo saves the new turn and any research or memory updates. The Next.js workspace receives progress and the answer over server-sent events.

~~~mermaid
flowchart LR
    B[Browser] --> N[Next.js chat workspace]
    N -->|Same-origin REST and SSE| A[FastAPI]
    A --> R[Routing and context]
    R -->|Read history, memory and snapshots| D[(PostgreSQL or local SQLite)]
    R -->|Plan search or generate answer| M[Groq or OpenAI]
    R -->|One web search tool| T[Tavily]
    T --> G[Validate excerpts and compare claims]
    M --> G
    G -->|Commit turn, memory and research| D
    G -->|Progress and saved reply| A
~~~

Groq hosts the default model in the example configuration. The same adapter supports OpenAI. The backend stores chat and research in PostgreSQL in production or SQLite locally. [Technical design](design.md)

## Why Echo is different

An earlier answer is a reference point you can return to. Echo keeps the evidence from the earlier check alongside what it finds on a recheck. It can report agreement, a change, or uncertainty, and you can open the Inspector to see why.

## Run locally

Use Python 3.12 or later and Node.js 22.18 or later. Run the backend commands from the repository root. On Windows, activate with `.\.venv\Scripts\Activate.ps1` and copy the example with `Copy-Item .env.example .env`.

~~~bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev]'
cp .env.example .env
# Set GROQ_API_KEY and TAVILY_API_KEY in .env.
python -m alembic upgrade head
python -m uvicorn echo.main:app --host 127.0.0.1 --port 8000
~~~

In another terminal:

~~~bash
cd frontend
npm ci
npm run dev
~~~

Open the [chat workspace](http://127.0.0.1:3000/) or the [API reference](http://127.0.0.1:8000/docs). FastAPI exposes database health at `GET /api/v1/health`.

| Variable | Where to set it | Purpose |
| --- | --- | --- |
| `ECHO_LLM_PROVIDER` | Backend | Choose `groq` or `openai`. The example selects Groq. |
| `GROQ_API_KEY`, `GROQ_MODEL` | Backend | Groq credential and optional model override. The example uses `openai/gpt-oss-20b`. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Backend | Credential and model override when using OpenAI. |
| `TAVILY_API_KEY` | Backend | Web search credential. |
| `ECHO_DATABASE_URL` | Backend | Defaults to local SQLite. Install `.[postgres]` to use PostgreSQL. |
| `ECHO_PUBLIC_DEMO`, `ECHO_BROWSER_SECRET` | Backend | Public mode requires PostgreSQL and a signing secret of at least 32 bytes. The secret keeps anonymous browser histories separate. |
| `ECHO_FRONTEND_ORIGIN` | Backend | Exact HTTPS frontend origin for direct browser CORS access. |
| `NEXT_PUBLIC_API_BASE_URL` | Frontend | Backend origin for the Next.js rewrite. Defaults to loopback locally and is required on Vercel production builds. |

Keep provider keys and signing credentials in the backend environment. Next.js forwards REST and SSE through the frontend origin and needs only the API origin.

## Try it

1. Start a chat and send “My interview is on Friday.” Then send “Actually, my interview was moved to Monday.”
2. Start a new chat in the same browser and ask “What is my interview plan?” A successful extraction and correction lets Echo recall Monday. Open **Agent Inspector → Saved memory** to see the active plan and the superseded record. Ambiguous statements can be skipped.
3. In a research chat, ask “What is the latest stable Python release?” Follow up with “Has anything changed since I last asked?” Inspect both replies to compare their retrieval dates and source excerpts. The result depends on the evidence available at the time.

## Test and evaluate

~~~bash
python -m ruff format --check .
python -m ruff check .
python -m pytest -q
python -m evals.run

cd frontend
npm run typecheck
npm run lint -- --max-warnings 0
npm test
npm run build
~~~

Backend tests use real migrations and controlled model and search responses. They exercise persistence, routing, citation validation, temporal comparison, memory correction, and SSE. The evaluation runner reports passed scenarios, provider and tool calls, and measured p50 and p95 local HTTP latency. Fixture latency excludes real provider network and inference time. [Verification details](VERIFICATION.md)

## Deployment

[Open Echo on Vercel](https://echo-time-aware-agent.vercel.app/) or check the [Render API health endpoint](https://echo-time-aware-api-gb19.onrender.com/api/v1/health).

The deployment pairs a Vercel Next.js project rooted at `frontend/` with a Render FastAPI service and managed PostgreSQL. The [Render Blueprint](render.yaml) wires the database connection into FastAPI, runs Alembic before Uvicorn, and configures the health endpoint. Use the deployed backend origin for the Vercel rewrite and the frontend origin for backend CORS. Each browser receives a signed, secure cookie so its saved sessions and memory are isolated from other visitors.

Render’s free service can cold-start after inactivity. Free Render PostgreSQL is suitable for a time-limited hiring demo and expires after 30 days. Longer retention requires a database that does not expire. [Render free-tier limits](https://render.com/docs/free)

## Limitations and next steps

The public demo uses anonymous browser identity, so clearing cookies or switching browsers loses access to that history. It has no account sign-in or deletion UI. PostgreSQL ranks a bounded recent set of rows and can miss older matches. Routing is primarily English, search coverage depends on Tavily, and a matching excerpt does not establish source credibility. The Inspector can show that Echo used context, but the API does not link individual saved memories to a reply.

Future work includes account authentication and retention controls, a PostgreSQL search index, stronger entity and unit normalization, and a labeled real-provider evaluation set. See [design.md](design.md) for the routing, storage, and evidence tradeoffs.
