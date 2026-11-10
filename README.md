# Echo

Echo is a time-aware research chat for the minimi engineering challenge. Its Next.js interface connects to a FastAPI backend that can recall a previous answer, search again, and compare evidence from two different points in time. Tavily web search is the model's only external tool.

## Run the backend

From this directory, with Python 3.12 or later:

~~~powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
Copy-Item .env.example .env
# Open .env and set OPENAI_API_KEY and TAVILY_API_KEY.
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -m uvicorn echo.main:app --host 127.0.0.1 --port 8000
~~~

On macOS/Linux use `python3.12 -m venv .venv`, `cp .env.example .env`, and replace `.\.venv\Scripts\python.exe` with `.venv/bin/python`. Run commands from the project root so the default SQLite path and `.env` resolve there. Browse [OpenAPI docs](http://127.0.0.1:8000/docs) or call `GET /api/v1/health`. Health checks schema access; they do not test provider credentials. Session and history APIs work without keys. Chat inference requires OpenAI; a turn requiring web search reports insufficient evidence if Tavily is unavailable.

Set `OPENAI_MODEL` to a Chat Completions model supporting strict function calls and structured output. For PostgreSQL install `".[dev,postgres]"`, set `ECHO_DATABASE_URL=postgresql+asyncpg://USER:PASSWORD@HOST/DB`, and run the same migrations before starting. SQLite uses FTS5 when available; PostgreSQL and SQLite without FTS5 use bounded ranking of recent rows. See [design.md](design.md) for database and deployment limits.

## Run the frontend

Keep the backend running on port 8000. In a second terminal, from the project root, run the following commands with Node.js 22.18 or later.

~~~powershell
cd frontend
npm.cmd ci
Copy-Item .env.example .env.local
npm.cmd run dev
~~~

On macOS and Linux, use `npm` and `cp .env.example .env.local`. Open [Echo Chat](http://127.0.0.1:3000).

`NEXT_PUBLIC_API_BASE_URL` is the backend origin and defaults to `http://127.0.0.1:8000`. Next.js forwards same-origin `/api/v1` requests to that origin. Set it before starting development or building for production. Put provider keys in the backend `.env`.

1. Start a new chat. Choose the Python release prompt to fill the composer and press **Enter** to send. Use **Shift+Enter** for a newline.
2. In the same chat, ask “Has anything changed?” or “What did you tell me earlier about Python?” Reopen the conversation from the sidebar to see its saved messages.
3. Open **Agent Inspector** to see the latest reply's search and memory usage, elapsed time, search calls, citations, detected changes, and trace ID. Select **Inspect** on an older reply to see its metadata. The backend does not return per-reply memory references.

The frontend uses session creation, session listing, message history, and the streaming chat endpoint. It uses the JSON chat endpoint if the server has no stream route. **Stop** cancels the browser request. Resending the same message after cancellation or interruption reuses the request ID in the current page so a committed reply can be recovered. Echo emits progress during processing and sends answer fragments after saving the turn.

### Frontend checks

From `frontend/`, run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. The test suite uses Node's built-in runner. See [verification](VERIFICATION.md) for the browser and backend checks.

### Publish the Git repository

With GitHub CLI installed and signed in, run this from the project root. Replace `YOUR_ACCOUNT` with your GitHub username or organization.

~~~powershell
gh repo create YOUR_ACCOUNT/echo --public --source . --remote origin --push
~~~

For an existing empty GitHub repository, use `git remote add origin <your-repository-url>` and `git push -u origin main`.

## API

| Method and path | Behavior |
| --- | --- |
| `POST /api/v1/sessions` | Create a session; optional JSON `{"title":"Research"}`. |
| `GET /api/v1/sessions` | List sessions for the demo identity, newest first; `limit` and `offset`. |
| `GET /api/v1/sessions/{id}/messages` | Return two messages per completed turn, oldest first. `limit` counts turns (max 100); increment `after` by the number of turns received. |
| `POST /api/v1/chat` | Send `session_id`, `message`, and optionally a UUID `request_id` to replay a completed request safely. |
| `POST /api/v1/chat/stream` | Same body; returns SSE. |
| `GET /api/v1/memories` | List active explicit user memories; filter by `kind` and pass `include_superseded=true` to see history. Supports `limit` and `offset`. |
| `GET /api/v1/health` | Check database access. |

~~~powershell
$echoBase = 'http://127.0.0.1:8000/api/v1'
$echoSession = Invoke-RestMethod -Method Post -Uri "$echoBase/sessions" -ContentType 'application/json' -Body '{"title":"Python releases"}'
function Ask-Echo([string]$message) {
    $echoBody = @{ session_id = $echoSession.id; message = $message; request_id = [guid]::NewGuid() } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "$echoBase/chat" -ContentType 'application/json' -Body $echoBody
}
Ask-Echo 'What is the latest stable Python release?'
Ask-Echo 'Has anything changed?'
Ask-Echo 'What did you tell me earlier about Python?'
Invoke-RestMethod "$echoBase/sessions/$($echoSession.id)/messages"
~~~

A successful recheck shows the original retrieval time and the current excerpts. If the excerpts establish a comparable value, `changes` says whether it changed. A missing or failed search yields `insufficient`, never an assertion of no change. These examples depend on current provider results; no Python version is assumed.

For a second example: send “My interview is on Friday.”, then “Actually, it was moved to Monday.”, then “What is my interview plan?”. Inspect `/memories?kind=plan&include_superseded=true` to see both records. Memory extraction is conservative and may skip an ambiguous correction.

`web_search_used` means a provider call was attempted. `search_status` distinguishes `live`, `cached`, `empty`, `unavailable`, `unsupported`, and `not_used`. A live status means the API retrieved excerpts during this turn; it says nothing about when Tavily indexed the underlying pages. Citations carry both `published_at` (when supplied) and `retrieved_at`; citation provenance is `live`, `cached`, or `historical`. The `evidence_mode` distinguishes model knowledge, conversation, historical recall, supported excerpts, and insufficient evidence.

A `request_id` is scoped to the session. Reuse it with the same text to get the original result and trace; different text returns HTTP 409. If overlapping requests race in one session, the losing write gets HTTP 409 and can be retried. Requests that fail before a completed turn is committed do not leave partial messages.

## SSE protocol

POST JSON with a client that can consume a response stream (for example, fetch or curl with `-N`; native EventSource uses GET). Event payloads are JSON:

| Event | Payload |
| --- | --- |
| `status` | `{stage, trace_id}` as the turn advances. |
| `sources` | `{citations: [...]}` before answer text. |
| `token` | `{text}` with a text fragment; concatenate in order. |
| `error` | `{code, message, trace_id}` for a failed turn after headers. |
| `completed` | `{ok:true,response:ChatView}` after commit or `{ok:false,trace_id}` after an error. |

The server streams progress while waiting, with heartbeat comments during long stages. It emits answer fragments only after validating and saving the reply; the fragments are not raw model tokens. Invalid request bodies return JSON HTTP 422 before streaming. A client disconnect can prevent delivery of the terminal event; retry with the same request ID to recover a committed answer.

## Verify

~~~powershell
.\.venv\Scripts\python.exe -m ruff format --check .
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m alembic check
.\.venv\Scripts\python.exe -m evals.run
~~~

Tests use a migrated, temporary database, a fixed clock, and fake providers; adapter contract tests exercise HTTP request shapes without credentials. The evaluation reports expected outcomes, tool and provider counts, and measured p50/p95 for fixture HTTP turns. Those timings are local baseline measurements, not real-provider latency or accuracy.

This is a single-user demo. It has no authentication, so bind it to loopback and keep `.env` private. The `demo_identity` dependency is the integration point for a future authenticated deployment.

