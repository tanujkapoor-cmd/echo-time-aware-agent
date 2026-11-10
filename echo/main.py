import asyncio
import json
import re
from collections.abc import Callable
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import datetime
from typing import Annotated
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, FastAPI, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from openai import AsyncOpenAI
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from echo.agent import ChatAgent
from echo.config import Settings
from echo.db import Memory, Session, Turn, database, utcnow
from echo.errors import EchoError
from echo.llm import Model, OpenAIModel
from echo.memory import memory_view, owned_session
from echo.schemas import (
    ChatInput,
    ChatView,
    CreateSession,
    MemoryKind,
    MemoryView,
    MessageView,
    SessionView,
)
from echo.search import SearchProvider, SearchService, TavilySearch
from echo.telemetry import configure, event

router = APIRouter(prefix="/api/v1")


def demo_identity(request: Request) -> str:
    """Single local identity; this dependency is the boundary for future authentication."""
    return request.app.state.settings.echo_demo_user


Identity = Annotated[str, Depends(demo_identity)]
Limit = Annotated[int, Query(ge=1, le=100)]
Offset = Annotated[int, Query(ge=0)]


@router.post("/sessions", response_model=SessionView, status_code=201)
async def create_session(request: Request, user_id: Identity, body: CreateSession | None = None):
    row = Session(
        id=str(uuid4()),
        title=body.title if body else None,
        user_id=user_id,
        created_at=request.app.state.clock(),
    )
    async with request.app.state.db.begin() as db:
        db.add(row)
    return SessionView.model_validate(row)


@router.get("/sessions", response_model=list[SessionView])
async def list_sessions(request: Request, user_id: Identity, limit: Limit = 50, offset: Offset = 0):
    async with request.app.state.db() as db:
        rows = await db.scalars(
            select(Session)
            .where(Session.user_id == user_id)
            .order_by(Session.created_at.desc(), Session.id)
            .limit(limit)
            .offset(offset)
        )
        return [SessionView.model_validate(row) for row in rows]


@router.get("/sessions/{session_id}/messages", response_model=list[MessageView])
async def messages(
    request: Request,
    user_id: Identity,
    session_id: UUID,
    limit: Limit = 50,
    after: Annotated[int, Query(ge=0)] = 0,
):
    async with request.app.state.db() as db:
        await owned_session(db, user_id, str(session_id))
        rows = await db.scalars(
            select(Turn)
            .where(Turn.session_id == str(session_id), Turn.sequence > after)
            .order_by(Turn.sequence)
            .limit(limit)
        )
        result = []
        for row in rows:
            reply = ChatView.model_validate(row.response)
            result += [
                MessageView(
                    id=row.user_message_id,
                    role="user",
                    content=row.question,
                    timestamp=row.asked_at,
                ),
                MessageView(
                    id=row.id,
                    role="assistant",
                    content=reply.answer,
                    timestamp=row.answered_at,
                    response=reply,
                ),
            ]
        return result


@router.get("/memories", response_model=list[MemoryView])
async def memories(
    request: Request,
    user_id: Identity,
    kind: MemoryKind | None = None,
    include_superseded: bool = False,
    limit: Limit = 50,
    offset: Offset = 0,
):
    query = select(Memory).where(Memory.user_id == user_id)
    if kind:
        query = query.where(Memory.kind == kind.value)
    if not include_superseded:
        query = query.where(Memory.active_key.is_not(None))
    async with request.app.state.db() as db:
        rows = await db.scalars(
            query.order_by(Memory.observed_at.desc(), Memory.id).limit(limit).offset(offset)
        )
        return [memory_view(row) for row in rows]


@router.get("/health")
async def health(request: Request):
    async with request.app.state.db() as db:
        await db.scalar(select(Session.id).limit(1))
    return {"status": "ok"}


@router.post("/chat", response_model=ChatView)
async def chat(request: Request, body: ChatInput, user_id: Identity):
    request.state.trace_id = uuid4()
    return await request.app.state.agent.chat(user_id, body, request.state.trace_id)


def _sse(name: str, payload: dict):
    return f"event: {name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _error(exc: EchoError, trace: UUID | None):
    return {"code": exc.code, "message": exc.message, "trace_id": str(trace) if trace else None}


@router.post(
    "/chat/stream",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {"schema": {"type": "string"}}}}},
)
async def stream(request: Request, body: ChatInput, user_id: Identity):
    trace = uuid4()
    agent = request.app.state.agent

    async def events():
        updates: asyncio.Queue[str | None] = asyncio.Queue()

        async def work():
            try:
                return await agent.chat(user_id, body, trace, updates.put_nowait)
            finally:
                updates.put_nowait(None)

        task = asyncio.create_task(work())
        try:
            while True:
                try:
                    stage = await asyncio.wait_for(updates.get(), timeout=10)
                except TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                if stage is None:
                    break
                yield _sse("status", {"stage": stage, "trace_id": str(trace)})
            try:
                reply = await task
            except Exception as exc:
                error = (
                    exc
                    if isinstance(exc, EchoError)
                    else EchoError("internal_error", "This turn failed.", 500)
                )
                yield _sse("error", _error(error, trace))
                yield _sse("completed", {"ok": False, "trace_id": str(trace)})
                return
            yield _sse(
                "sources", {"citations": [item.model_dump(mode="json") for item in reply.citations]}
            )
            for piece in re.findall(r"\S+\s*|\s+", reply.answer):
                yield _sse("token", {"text": piece})
            yield _sse("completed", {"ok": True, "response": reply.model_dump(mode="json")})
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def create_app(
    settings: Settings | None = None,
    *,
    model: Model | None = None,
    provider: SearchProvider | None = None,
    clock: Callable[[], datetime] = utcnow,
) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        configure(settings.echo_log_level)
        async with AsyncExitStack() as stack:
            engine, factory = database(settings.echo_database_url)
            stack.push_async_callback(engine.dispose)
            tavily = provider
            if tavily is None:
                http = await stack.enter_async_context(
                    httpx.AsyncClient(
                        timeout=settings.echo_search_timeout,
                        follow_redirects=False,
                        limits=httpx.Limits(max_connections=24, max_keepalive_connections=12),
                    )
                )
                tavily = TavilySearch(http, settings.tavily_api_key.get_secret_value(), clock)

            inference = model
            if inference is None:
                key = settings.openai_api_key.get_secret_value()
                client = None
                if key:
                    client = await stack.enter_async_context(
                        AsyncOpenAI(api_key=key, max_retries=0, timeout=settings.echo_model_timeout)
                    )
                inference = OpenAIModel(client, settings.openai_model, settings.echo_model_timeout)
            app.state.db = factory
            app.state.agent = ChatAgent(
                factory, inference, SearchService(tavily, settings, clock), settings, clock
            )
            yield

    app = FastAPI(
        title="Echo",
        version="0.1.0",
        description="Time-aware chat and research. This instance uses a single local demo identity.",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.clock = clock

    @app.exception_handler(EchoError)
    async def service_error(request: Request, exc: EchoError):
        return JSONResponse(
            {"error": _error(exc, getattr(request.state, "trace_id", None))},
            status_code=exc.status,
        )

    @app.exception_handler(SQLAlchemyError)
    async def database_error(request: Request, _: SQLAlchemyError):
        event("database_unavailable")
        return await service_error(
            request, EchoError("database_unavailable", "Conversation storage is unavailable.")
        )

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_: Request, exc: RequestValidationError):
        errors = [{"path": err["loc"], "code": err["type"]} for err in exc.errors()]
        return JSONResponse(
            {"error": {"code": "invalid_request", "fields": errors}}, status_code=422
        )

    @app.get("/", include_in_schema=False)
    async def index():
        return Response(status_code=307, headers={"Location": "/docs"})

    app.include_router(router)
    return app


app = create_app()
