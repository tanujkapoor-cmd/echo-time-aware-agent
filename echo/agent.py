import asyncio
import re
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from enum import StrEnum
from time import perf_counter
from uuid import UUID, uuid4

from pydantic import ValidationError
from sqlalchemy import update
from sqlalchemy.exc import SQLAlchemyError

from echo.config import Settings
from echo.context import answer_context, archived_reply, conversation, stored_claims
from echo.db import Session, Snapshot, Turn, utcnow
from echo.errors import EchoError, ModelUnavailable, SearchUnavailable
from echo.evidence import compare, describe_changes, ground
from echo.llm import Draft, Model
from echo.memory import (
    Context,
    MemoryCandidate,
    anchor,
    apply_memories,
    distinct_topics,
    load_context,
    normalized,
    replay_turn,
)
from echo.routing import (
    Decision,
    Route,
    decide,
    has_subject,
    personal_statement,
    recalls_user_words,
    topic_key,
    volatility,
)
from echo.schemas import ChatInput, ChatView, Citation, EvidenceMode, SearchStatus, Timing
from echo.search import Batch, SearchInput, SearchResult, SearchService
from echo.telemetry import event, ms


class Stage(StrEnum):
    RECEIVE = "receive_query"
    LOAD = "load_context"
    DECIDE = "decide_search"
    SEARCH = "execute_search"
    GENERATE = "generate_answer"
    VALIDATE = "validate_response"
    PERSIST = "persist_memory"
    COMPLETE = "complete"


_TRANSITIONS = {
    Stage.RECEIVE: {Stage.LOAD},
    Stage.LOAD: {Stage.DECIDE, Stage.COMPLETE},
    Stage.DECIDE: {Stage.SEARCH, Stage.GENERATE},
    Stage.SEARCH: {Stage.GENERATE},
    Stage.GENERATE: {Stage.VALIDATE},
    Stage.VALIDATE: {Stage.PERSIST},
    Stage.PERSIST: {Stage.COMPLETE},
}


@dataclass
class Run:
    trace: UUID
    notify: Callable[[str], None]
    started: float = field(default_factory=perf_counter)
    stage: Stage = Stage.RECEIVE
    timing: Timing = field(default_factory=Timing)
    route: Route | None = None
    search_status: SearchStatus | None = None
    resolver_used_memory: bool = False

    def move(self, step: Stage):
        if step not in _TRANSITIONS.get(self.stage, ()):
            raise RuntimeError(f"Invalid state transition: {self.stage} to {step}")
        self.stage = step
        self.notify(step.value)

    async def model(self, call, payload):
        start = perf_counter()
        self.timing.model_calls += 1
        try:
            result, tokens = await call(payload)
        finally:
            self.timing.llm_ms += ms(start)
        if tokens is not None:
            self.timing.tokens = (self.timing.tokens or 0) + tokens
        return result


@dataclass
class Research:
    status: SearchStatus
    hits: dict[str, SearchResult] = field(default_factory=dict)
    query: str = ""
    cached: bool = False


@dataclass
class Result:
    answer: str
    citations: list[Citation]
    mode: EvidenceMode
    changes: list = field(default_factory=list)
    claims: list = field(default_factory=list)
    memories: list[MemoryCandidate] = field(default_factory=list)


class ChatAgent:
    def __init__(
        self, factory, model: Model, search: SearchService, settings: Settings, clock=utcnow
    ):
        self.db = factory
        self.model = model
        self.search = search
        self.settings = settings
        self.clock = clock

    async def chat(
        self,
        user_id: str,
        body: ChatInput,
        trace: UUID,
        notify: Callable[[str], None] = lambda _: None,
    ) -> ChatView:
        run = Run(trace, notify)
        notify(run.stage.value)
        status = "ok"
        try:
            async with asyncio.timeout(self.settings.echo_turn_timeout):
                return await self._chat(user_id, body, run)
        except EchoError as exc:
            status = exc.code
            raise
        except TimeoutError:
            status = "turn_timeout"
            raise EchoError(status, "This turn took too long; retry the message.", 504) from None
        except ModelUnavailable as exc:
            status = "model_unavailable"
            raise EchoError(status, str(exc)) from None
        except SQLAlchemyError:
            status = "database_unavailable"
            raise EchoError(status, "Conversation storage is unavailable.") from None
        except asyncio.CancelledError:
            status = "cancelled"
            raise
        except Exception:
            status = "internal_error"
            raise
        finally:
            event(
                "chat_turn",
                trace_id=str(trace),
                state=run.stage.value,
                status=status,
                route=run.route,
                search_status=run.search_status,
                elapsed_ms=ms(run.started),
                **run.timing.model_dump(),
            )

    async def _resolve(
        self,
        run: Run,
        message: str,
        decision: Decision,
        ctx: Context,
        session_id: str,
    ) -> tuple[Decision, Snapshot | None, str | None, bool]:
        if decision.route in {Route.GENERAL, Route.HISTORY} or personal_statement(message):
            return decision, None, None, False
        if decision.route == Route.FRESH and not decision.refers_back:
            return decision, None, None, False

        baseline, candidates = anchor(message, session_id, ctx)
        vague = not has_subject(message)
        if decision.route == Route.COMPARE:
            if baseline:
                return decision, baseline, None, False
            if not candidates:
                return decision, None, None, True
        elif decision.route == Route.FRESH:
            if baseline and vague:
                return decision, baseline, None, False
            if not vague:
                return decision, None, None, False
            if not candidates and not ctx.turns:
                return decision, None, None, True
        elif not ctx.turns or not ctx.snapshots or re.search(r"\b(?:my|our)\b", message, re.I):
            return decision, None, None, False

        options = candidates or ([baseline] if baseline else distinct_topics(ctx.snapshots))
        run.resolver_used_memory = bool(options or ctx.turns)
        try:
            resolved = await run.model(
                self.model.resolve,
                {
                    "question": message,
                    "conversation": conversation(
                        sorted(ctx.turns, key=lambda row: row.sequence)[-4:]
                    ),
                    "options": [
                        {
                            "id": row.id,
                            "topic": row.topic_key,
                            "query": row.search_query,
                            "retrieved_at": row.retrieved_at.isoformat(),
                        }
                        for row in options
                    ],
                },
            )
        except ModelUnavailable:
            return decision, None, None, decision.needs_search
        selected = next((row for row in options if row.id == resolved.snapshot_id), None)
        if decision.route == Route.FOLLOWUP and resolved.needs_search:
            decision = replace(decision, route=Route.FRESH, force_fresh=True)
        topic = None
        candidate = (resolved.public_topic or "").strip()
        if decision.route == Route.FRESH and not selected and 1 <= len(candidate) <= 120:
            if any(
                candidate in row.question and not personal_statement(row.question)
                for row in ctx.turns
            ):
                topic = candidate
        return decision, selected, topic, decision.needs_search and not (selected or topic)

    async def _research(
        self,
        user_id: str,
        message: str,
        decision: Decision,
        ctx: Context,
        baseline: Snapshot | None,
        topic: str | None,
        run: Run,
        now: datetime,
    ) -> Research:
        # Reuse a durable snapshot only for the same original question. Topic similarity alone
        # does not show that two questions are equivalent.
        for row in ctx.snapshots:
            if (
                not decision.force_fresh
                and not decision.refers_back
                and normalized(row.question) == normalized(message)
                and now < row.expires_at
                and self.search.freshness.reusable(decision, row.retrieved_at, now)
            ):
                hits = [SearchResult.model_validate(item) for item in row.sources]
                if hits:
                    run.timing.cache_hits += 1
                    return Research(SearchStatus.CACHED, _source_map(hits), row.search_query, True)

        previous_queries = []
        for _ in range(self.settings.echo_max_search_calls):
            calls = await run.model(
                self.model.tool_call,
                {
                    "question": message,
                    "prior_public_search_query": baseline.search_query if baseline else None,
                    "public_topic": topic,
                    "prior_empty_queries": previous_queries,
                    "now_utc": now.isoformat(),
                },
            )
            valid = [item for item in calls if item.name == "web_search"]
            if len(calls) != 1 or len(valid) != 1:
                break
            try:
                args = SearchInput.model_validate_json(valid[0].arguments)
            except ValidationError:
                break
            args.query = " ".join(args.query.split())
            if not args.query or normalized(args.query) in map(normalized, previous_queries):
                break
            args.max_results = min(args.max_results, self.settings.echo_max_search_results)
            previous_queries.append(args.query)
            run.timing.search_calls += 1
            started = perf_counter()
            try:
                batch: Batch = await self.search.run(user_id, args, decision, run.timing)
            except SearchUnavailable:
                return Research(SearchStatus.UNAVAILABLE)
            finally:
                run.timing.search_ms += ms(started)
            if batch.results:
                return Research(
                    SearchStatus.CACHED if batch.cached else SearchStatus.LIVE,
                    _source_map(batch.results),
                    args.query,
                    batch.cached,
                )
        return Research(SearchStatus.EMPTY if previous_queries else SearchStatus.UNAVAILABLE)

    async def _generate(
        self,
        message: str,
        now: datetime,
        decision: Decision,
        ctx: Context,
        research: Research,
        baseline: Snapshot | None,
        clarify: bool,
        run: Run,
    ) -> Draft | Result:
        if clarify:
            if decision.route == Route.COMPARE and not ctx.snapshots:
                answer = (
                    "I don't have a saved research answer to compare. What topic should I check?"
                )
            else:
                answer = "Which topic should I check? I couldn't reliably resolve the reference."
            changes = compare([], []) if decision.route == Route.COMPARE else []
            return Result(answer, [], EvidenceMode.INSUFFICIENT, changes=changes)
        if decision.route == Route.HISTORY:
            if not ctx.turns:
                return Result(
                    "I couldn't find a saved reply matching that period or request.",
                    [],
                    EvidenceMode.HISTORICAL,
                )
            if len(ctx.turns) == 1:
                previous = ctx.turns[0]
                if recalls_user_words(message):
                    stamp = previous.asked_at.isoformat(timespec="seconds")
                    return Result(
                        f"On {stamp} you wrote:\n\n{previous.question}", [], EvidenceMode.HISTORICAL
                    )
                answer, sources = archived_reply(previous)
                return Result(answer, sources, EvidenceMode.HISTORICAL)
        if decision.needs_search and not research.hits:
            return _no_evidence(research.status, baseline, decision)

        return await run.model(
            self.model.answer,
            answer_context(message, now, decision, ctx, research.hits, baseline, research.cached),
        )

    @staticmethod
    def _validate(
        draft: Draft | Result,
        decision: Decision,
        ctx: Context,
        research: Research,
        baseline: Snapshot | None,
    ) -> Result:
        if isinstance(draft, Result):
            return draft
        if not research.hits:
            answer = _plain_answer(draft.answer)
            if decision.route == Route.HISTORY:
                answer += "\n\nThis recalls saved conversation; I have not checked it again."
            mode = (
                EvidenceMode.HISTORICAL
                if decision.route == Route.HISTORY
                else EvidenceMode.CONVERSATION
                if ctx.turns or ctx.memories
                else EvidenceMode.MODEL_KNOWLEDGE
            )
            return Result(answer, [], mode, memories=draft.memories)

        grounded = ground(draft.excerpts, draft.facts, research.hits, research.cached)
        if not grounded.citations:
            research.status = SearchStatus.UNSUPPORTED
            return _no_evidence(research.status, baseline, decision)
        title = (
            "From saved search excerpts (not checked again this turn):"
            if research.cached
            else "From search excerpts retrieved for this turn:"
        )
        current = grounded.claims
        if decision.route == Route.COMPARE:
            changes = compare(stored_claims(baseline), current if not research.cached else [])
        else:
            changes = [item for item in compare([], current) if item.kind.value == "conflicting"]
        citations = [*grounded.citations, *(_historical_citations(baseline) if changes else [])]
        notes = describe_changes(changes, citations)
        if notes and baseline:
            notes = f"Compared with evidence retrieved {baseline.retrieved_at.isoformat(timespec='seconds')}.\n{notes}"
        mode = EvidenceMode.CACHED_SNIPPETS if research.cached else EvidenceMode.LIVE_SNIPPETS
        return Result(
            (notes + "\n\n" if notes else "") + title + "\n" + grounded.render(),
            citations,
            mode,
            changes=changes,
            claims=current,
        )

    async def _chat(self, user_id: str, body: ChatInput, run: Run) -> ChatView:
        session_id = str(body.session_id)
        request_id = str(body.request_id) if body.request_id else None
        now = self.clock()
        decision = decide(body.message)
        run.move(Stage.LOAD)
        started = perf_counter()
        try:
            async with self.db() as db:
                ctx = await load_context(
                    db, user_id, session_id, request_id, body.message, decision, now
                )
        finally:
            run.timing.memory_ms += ms(started)
        if ctx.replay:
            run.move(Stage.COMPLETE)
            return ctx.replay

        run.move(Stage.DECIDE)
        decision, baseline, topic, clarify = await self._resolve(
            run, body.message, decision, ctx, session_id
        )
        run.route = decision.route
        if baseline and decision.needs_search and decision.volatility.value == "general":
            decision = replace(decision, volatility=volatility(baseline.search_query))
        research = Research(SearchStatus.NOT_USED)
        if decision.needs_search and not clarify:
            run.move(Stage.SEARCH)
            research = await self._research(
                user_id, body.message, decision, ctx, baseline, topic, run, now
            )
        run.move(Stage.GENERATE)
        draft = await self._generate(
            body.message, now, decision, ctx, research, baseline, clarify, run
        )
        run.move(Stage.VALIDATE)
        result = self._validate(draft, decision, ctx, research, baseline)
        run.search_status = research.status
        reply = ChatView(
            message_id=uuid4(),
            answer=result.answer,
            timestamp=self.clock(),
            citations=result.citations,
            web_search_used=run.timing.provider_calls > 0,
            memory_used=bool(
                baseline
                or topic
                or run.resolver_used_memory
                or (not decision.needs_search and (ctx.turns or ctx.memories))
                or (research.cached and not run.timing.search_calls)
            ),
            evidence_mode=result.mode,
            search_status=research.status,
            changes=result.changes,
            baseline_at=baseline.retrieved_at if baseline else None,
            trace_id=run.trace,
            elapsed_ms=ms(run.started),
            timing=run.timing,
        )
        run.move(Stage.PERSIST)
        reply = await self._persist(
            user_id,
            session_id,
            request_id,
            body.message,
            now,
            ctx,
            reply,
            research,
            result,
            decision,
            baseline,
        )
        run.move(Stage.COMPLETE)
        return reply

    async def _persist(
        self,
        user_id,
        session_id,
        request_id,
        message,
        now,
        ctx,
        reply,
        research,
        result,
        decision,
        baseline,
    ) -> ChatView:
        async with self.db.begin() as db:
            # Optimistic write fence across processes. The slow work holds no database lock.
            revision = await db.execute(
                update(Session)
                .where(
                    Session.id == session_id,
                    Session.user_id == user_id,
                    Session.revision == ctx.revision,
                )
                .values(revision=ctx.revision + 1)
            )
            if revision.rowcount != 1:
                replay = await replay_turn(db, session_id, request_id, message)
                if replay:
                    return replay
                raise EchoError(
                    "session_conflict", "Another message completed first; retry this message.", 409
                )
            turn = Turn(
                id=str(reply.message_id),
                session_id=session_id,
                request_id=request_id,
                sequence=ctx.revision + 1,
                user_message_id=str(uuid4()),
                question=message,
                asked_at=now,
                answered_at=reply.timestamp,
                response=reply.model_dump(mode="json"),
            )
            db.add(turn)
            await db.flush()
            await apply_memories(db, user_id, turn, ctx, result.memories)
            if result.mode == EvidenceMode.LIVE_SNIPPETS:
                used = {cite.url for cite in result.citations if cite.provenance == "live"}
                sources = [item for item in research.hits.values() if item.url in used]
                retrieved_at = max(item.retrieved_at for item in sources)
                db.add(
                    Snapshot(
                        id=turn.id,
                        session_id=session_id,
                        user_id=user_id,
                        question=message,
                        topic_key=baseline.topic_key if baseline else topic_key(research.query),
                        search_query=research.query,
                        asked_at=now,
                        retrieved_at=retrieved_at,
                        expires_at=retrieved_at
                        + timedelta(seconds=self.search.freshness.ttl(decision)),
                        answer_summary=reply.answer,
                        claims=[claim.model_dump(mode="json") for claim in result.claims],
                        sources=[item.model_dump(mode="json") for item in sources],
                    )
                )
        return reply


def _source_map(hits) -> dict[str, SearchResult]:
    return {f"R{i}": hit for i, hit in enumerate(hits, 1)}


def _historical_citations(baseline: Snapshot | None) -> list[Citation]:
    if not baseline:
        return []
    sources = {item.url: item for item in map(SearchResult.model_validate, baseline.sources)}
    return [
        Citation(
            id=f"H{i}",
            title=sources[claim.source_url].title,
            url=claim.source_url,
            quote=claim.quote,
            published_at=sources[claim.source_url].published_at,
            retrieved_at=claim.observed_at,
            provenance="historical",
        )
        for i, claim in enumerate(stored_claims(baseline), 1)
        if claim.source_url in sources
    ]


def _no_evidence(status: SearchStatus, baseline: Snapshot | None, decision: Decision) -> Result:
    message = {
        SearchStatus.UNAVAILABLE: "I couldn't verify this because the web search did not complete.",
        SearchStatus.EMPTY: "I couldn't verify this because the search returned no usable results.",
        SearchStatus.UNSUPPORTED: "I couldn't verify this from the retrieved search excerpts.",
    }[status]
    changes = []
    if decision.route == Route.COMPARE:
        changes = compare(stored_claims(baseline), [])
        if baseline:
            message += f" The previous evidence was retrieved {baseline.retrieved_at.isoformat(timespec='seconds')}."
        message += " I can't determine whether the answer changed."
    return Result(
        message, _historical_citations(baseline), EvidenceMode.INSUFFICIENT, changes=changes
    )


def _plain_answer(answer: str) -> str:
    answer = re.sub(r"\[(?:[A-Z]\d+|\d+)\]", "", answer, flags=re.I)
    answer = re.sub(r"https?://[^\s<>()]+", "[unverified link removed]", answer, flags=re.I)
    if not answer.strip():
        raise ModelUnavailable("The language model did not return a usable answer.")
    return answer.strip()[:9000]
