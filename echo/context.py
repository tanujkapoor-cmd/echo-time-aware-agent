from datetime import datetime

from echo.db import Snapshot, Turn
from echo.memory import Context, clip
from echo.routing import Decision, Route, personal_statement
from echo.schemas import ChatView, Citation, Claim
from echo.search import SearchResult


def conversation(turns: list[Turn], *, with_answers: bool = True) -> list[dict]:
    result = []
    for row in sorted(turns, key=lambda item: (item.asked_at, item.sequence)):
        data = {
            "asked_at": row.asked_at.isoformat(),
            "user": clip(row.question, 600),
        }
        if with_answers:
            data["assistant"] = clip(row.response["answer"], 800)
            data["answered_at"] = row.answered_at.isoformat()
            data["evidence_mode"] = row.response["evidence_mode"]
        result.append(data)
    return result


def stored_claims(snapshot: Snapshot | None) -> list[Claim]:
    return [Claim.model_validate(item) for item in snapshot.claims] if snapshot else []


def answer_context(
    message: str,
    now: datetime,
    decision: Decision,
    context: Context,
    sources: dict[str, SearchResult],
    baseline: Snapshot | None,
    cached: bool,
) -> dict:
    data = {
        "question": message,
        "now_utc": now.isoformat(),
        "route": decision.route.value,
        "extract_memory": personal_statement(message),
    }
    if not sources:
        data["conversation"] = conversation(context.turns)
        if decision.route != Route.HISTORY:
            data["active_user_memories"] = [
                {"id": row.id, "kind": row.kind, "key": row.key, "quote": clip(row.content, 400)}
                for row in context.memories
            ]
        return data
    data["source_provenance"] = "cache" if cached else "provider_called_this_turn"
    data["sources"] = {
        key: {
            "title": item.title,
            "snippet": item.snippet,
            "retrieved_at": item.retrieved_at.isoformat(),
            "published_at": item.published_at.isoformat() if item.published_at else None,
        }
        for key, item in sources.items()
    }
    data["baseline_keys"] = [
        {"subject": claim.subject, "attribute": claim.attribute}
        for claim in stored_claims(baseline)
    ]
    if baseline:
        data["prior_public_search_query"] = baseline.search_query
    return data


def archived_reply(turn: Turn) -> tuple[str, list[Citation]]:
    old = ChatView.model_validate(turn.response)
    # Use the stored ID labels: they refer to exact stored quotations and URLs.
    citations = [item.model_copy(update={"provenance": "historical"}) for item in old.citations]
    return (
        f"On {turn.answered_at.isoformat(timespec='seconds')} I answered:\n\n"
        f"{old.answer}\n\nThis is the saved reply; I have not checked it again.",
        citations,
    )
