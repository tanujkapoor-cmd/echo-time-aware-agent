import re
from dataclasses import dataclass
from datetime import datetime
from uuid import uuid4

from pydantic import BaseModel, Field
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from echo.db import Memory, Session, Snapshot, Turn
from echo.errors import EchoError
from echo.routing import Decision, Route, has_subject, historical_window, personal_statement, terms
from echo.schemas import ChatView, MemoryKind, MemoryView

RECENT_LIMIT = 6
CANDIDATE_LIMIT = 48


def normalized(value: str) -> str:
    return " ".join(value.casefold().split())


def clip(value: str, limit: int) -> str:
    return value[:limit] + ("…" if len(value) > limit else "")


def _relevance(query: str, document: str) -> float:
    wanted = set(terms(query))
    return len(wanted.intersection(terms(document))) / max(len(wanted), 1)


async def _indexed_ids(
    db: AsyncSession,
    user_id: str,
    table: str,
    query: str,
    session_id: str | None,
) -> list[str]:
    """SQLite FTS generates candidates; missing FTS or another dialect uses bounded ranking."""
    if db.bind.dialect.name != "sqlite" or not terms(query):
        return []
    indexed = await db.scalar(
        text("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:name"),
        {"name": f"{table}_fts"},
    )
    if not indexed:
        return []
    # Only application-defined tables reach this helper. Tokens are data, never FTS syntax.
    if table == "turns":
        ownership = "JOIN sessions s ON s.id = d.session_id WHERE s.user_id = :owner"
    elif table == "snapshots":
        ownership = "WHERE d.user_id = :owner"
    else:
        raise ValueError("Unknown FTS index")
    session_filter = "AND d.session_id = :session" if session_id else ""
    fts_query = " OR ".join('"' + token + '"' for token in terms(query)[:14])
    return list(
        await db.scalars(
            text(
                f"SELECT d.id FROM {table}_fts JOIN {table} d ON d.id = {table}_fts.doc_id "
                f"{ownership} {session_filter} AND {table}_fts MATCH :query "
                f"ORDER BY rank, d.id LIMIT {CANDIDATE_LIMIT}"
            ),
            {"owner": user_id, "query": fts_query, "session": session_id},
        )
    )


@dataclass
class Context:
    revision: int
    turns: list[Turn]
    memories: list[Memory]
    snapshots: list[Snapshot]
    replay: ChatView | None = None


async def owned_session(db: AsyncSession, user_id: str, session_id: str) -> Session:
    row = await db.scalar(
        select(Session).where(Session.user_id == user_id, Session.id == session_id)
    )
    if row is None:
        raise EchoError("session_not_found", "Conversation session not found.", 404)
    return row


async def replay_turn(
    db: AsyncSession, session_id: str, request_id: str | None, message: str
) -> ChatView | None:
    if not request_id:
        return None
    turn = await db.scalar(
        select(Turn).where(Turn.session_id == session_id, Turn.request_id == request_id)
    )
    if not turn:
        return None
    if turn.question != message:
        raise EchoError(
            "request_id_conflict", "This request ID already belongs to another message.", 409
        )
    return ChatView.model_validate(turn.response)


async def load_context(
    db: AsyncSession,
    user_id: str,
    session_id: str,
    request_id: str | None,
    query: str,
    decision: Decision,
    now: datetime,
) -> Context:
    session = await owned_session(db, user_id, session_id)
    replay = await replay_turn(db, session_id, request_id, query)
    if replay:
        return Context(session.revision, [], [], [], replay)
    turn_query = (
        select(Turn).join(Session, Turn.session_id == Session.id).where(Session.user_id == user_id)
    )
    window = historical_window(query, now) if decision.route == Route.HISTORY else None
    if decision.route != Route.HISTORY:
        turn_query = turn_query.where(Turn.session_id == session_id)
    if window:
        turn_query = turn_query.where(Turn.asked_at >= window[0], Turn.asked_at < window[1])
    turns = list(
        await db.scalars(
            turn_query.order_by(Turn.asked_at.desc(), Turn.sequence.desc(), Turn.id.desc()).limit(
                CANDIDATE_LIMIT if decision.refers_back else RECENT_LIMIT
            )
        )
    )
    if decision.refers_back:
        ids = await _indexed_ids(
            db, user_id, "turns", query, None if decision.route == Route.HISTORY else session_id
        )
        if ids:
            indexed = await db.scalars(turn_query.where(Turn.id.in_(ids)))
            turns = list({row.id: row for row in [*turns, *indexed]}.values())
        recent = turns[:3]
        ranked = sorted(
            turns,
            key=lambda row: (_relevance(query, row.question), row.asked_at, row.sequence),
            reverse=True,
        )
        ordered = [*ranked, *recent] if decision.route == Route.HISTORY else [*recent, *ranked]
        turns = list({row.id: row for row in ordered}.values())[:RECENT_LIMIT]

    memories = []
    if decision.refers_back or personal_statement(query):
        candidates = await db.scalars(
            select(Memory)
            .where(Memory.user_id == user_id, Memory.active_key.is_not(None))
            .order_by(Memory.observed_at.desc(), Memory.id)
            .limit(CANDIDATE_LIMIT)
        )
        memories = sorted(
            candidates,
            key=lambda row: (_relevance(query, row.key + " " + row.content), row.observed_at),
            reverse=True,
        )[:8]

    snapshots = []
    if decision.needs_search or decision.route in {Route.FOLLOWUP, Route.HISTORY}:
        owned = select(Snapshot).where(Snapshot.user_id == user_id)
        snapshot_ids = await _indexed_ids(db, user_id, "snapshots", query, None)
        recent_here = list(
            await db.scalars(
                owned.where(Snapshot.session_id == session_id)
                .order_by(Snapshot.retrieved_at.desc(), Snapshot.id)
                .limit(CANDIDATE_LIMIT)
            )
        )
        recent_user = await db.scalars(
            owned.order_by(Snapshot.retrieved_at.desc(), Snapshot.id).limit(CANDIDATE_LIMIT)
        )
        indexed = (
            await db.scalars(owned.where(Snapshot.id.in_(snapshot_ids))) if snapshot_ids else []
        )
        unique = {row.id: row for row in [*recent_here, *recent_user, *indexed]}
        snapshots = sorted(
            unique.values(),
            key=lambda row: (
                _relevance(query, row.topic_key + " " + row.question),
                row.session_id == session_id,
                row.retrieved_at,
                row.id,
            ),
            reverse=True,
        )[:12]
    return Context(session.revision, turns, memories, snapshots)


def distinct_topics(snapshots: list[Snapshot]) -> list[Snapshot]:
    newest = {}
    for row in sorted(snapshots, key=lambda item: item.retrieved_at, reverse=True):
        newest.setdefault(row.topic_key, row)
    return [newest[row.topic_key] for row in snapshots if row.id == newest[row.topic_key].id][:6]


def anchor(query: str, session_id: str, context: Context) -> tuple[Snapshot | None, list[Snapshot]]:
    """Select an unambiguous baseline, or return the model's bounded choice set."""
    topics = distinct_topics(context.snapshots)
    scored = [(row, _relevance(query, row.topic_key)) for row in topics]
    matching = [(row, score) for row, score in scored if score > 0]
    if matching:
        best = max(score for _, score in matching)
        tied = [row for row, score in matching if score == best]
        if len(tied) == 1:
            return tied[0], []
        return None, tied
    # A newer unresearched turn may be the real referent. Only take a direct, unqualified
    # continuation without a resolver call.
    if context.turns and not has_subject(query):
        latest = max(context.turns, key=lambda row: row.sequence)
        attached = [row for row in context.snapshots if row.id == latest.id]
        if attached:
            return attached[0], []
    local = [row for row in topics if row.session_id == session_id]
    return None, local or topics


class MemoryCandidate(BaseModel):
    kind: MemoryKind
    key: str = Field(min_length=1, max_length=80)
    quote: str = Field(min_length=3, max_length=600)
    replaces_id: str | None


def memory_view(row: Memory) -> MemoryView:
    return MemoryView(
        id=row.id,
        kind=row.kind,
        key=row.key,
        content=row.content,
        observed_at=row.observed_at,
        created_at=row.created_at,
        source_message_ids=[row.source_message_id],
        active=row.active_key is not None,
        superseded_at=row.superseded_at,
        replaces_id=row.replaces_id,
    )


def _write_conflict() -> EchoError:
    return EchoError("memory_conflict", "Memory changed during this turn; retry the message.", 409)


async def apply_memories(
    db: AsyncSession,
    user_id: str,
    turn: Turn,
    context: Context,
    candidates: list[MemoryCandidate],
):
    if not personal_statement(turn.question):
        return
    allowed = {row.id: row for row in context.memories}
    seen = set()
    for candidate in candidates[:3]:
        quote = candidate.quote.strip()
        if " ".join(quote.split()) not in " ".join(turn.question.split()) or not personal_statement(
            quote
        ):
            continue
        key = "-".join(re.findall(r"[^\W_]+", candidate.key.casefold()))[:80].strip("-")
        if not key:
            continue
        prior = allowed.get(candidate.replaces_id)
        if candidate.replaces_id and not prior:
            continue
        if prior:
            kind, key = prior.kind, prior.key
        else:
            kind = candidate.kind.value
        slot = f"{kind}:{key}"
        if slot in seen:
            continue
        seen.add(slot)
        existing = await db.scalar(
            select(Memory).where(Memory.user_id == user_id, Memory.active_key == slot)
        )
        if existing:
            if normalized(existing.content) == normalized(quote):
                continue
            # Only supersede a memory the extraction explicitly selected and still active.
            if not prior:
                continue
            if existing.id != prior.id or existing.observed_at > turn.asked_at:
                raise _write_conflict()
            touched = await db.execute(
                update(Memory)
                .where(Memory.id == existing.id, Memory.active_key == slot)
                .values(active_key=None, superseded_at=turn.asked_at)
            )
            if touched.rowcount != 1:
                raise _write_conflict()
        elif prior:
            raise _write_conflict()
        elif re.match(r"^(actually|correction|instead|update)\b", quote, re.I):
            # A pronoun-only correction without a resolved target is not useful as a new slot.
            continue
        db.add(
            Memory(
                id=str(uuid4()),
                user_id=user_id,
                kind=kind,
                key=key,
                active_key=slot,
                content=quote,
                observed_at=turn.asked_at,
                created_at=turn.answered_at,
                source_message_id=turn.user_message_id,
                replaces_id=existing.id if existing else None,
            )
        )
        try:
            await db.flush()
        except IntegrityError:
            raise _write_conflict() from None
