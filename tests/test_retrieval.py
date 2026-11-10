from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import text, update

from echo.db import Session, Turn
from echo.evidence import Witness
from echo.llm import Resolution
from echo.main import demo_identity
from evals.fakes import FakeModel, FakeSearch, draft, release, release_draft, tool

from .conftest import app_for, client_for, send, session


async def test_fts_recovers_turn_outside_recent_window(settings, clock):
    old = "What is a quasicrystal?"

    def recall(data):
        assert any(row["user"] == old for row in data["conversation"])
        return draft("We discussed aperiodic order.")

    app = app_for(
        settings,
        clock,
        FakeModel(answers=[draft("It has aperiodic order."), recall]),
        FakeSearch(),
    )
    async with app.router.lifespan_context(app), client_for(app) as client:
        sid = await session(client)
        seed = await send(client, sid, old)
        async with app.state.db.begin() as db:
            fts_exists = await db.scalar(
                text("SELECT 1 FROM sqlite_master WHERE name='turns_fts' AND type='table'")
            )
            if not fts_exists:
                pytest.skip("This SQLite build does not provide FTS5")
            for index in range(2, 57):
                dt = clock.now + timedelta(seconds=index)
                db.add(
                    Turn(
                        id=str(uuid4()),
                        user_message_id=str(uuid4()),
                        session_id=sid,
                        sequence=index,
                        question=f"Unrelated conversation {index}",
                        asked_at=dt,
                        answered_at=dt,
                        response=seed,
                    )
                )
            await db.execute(update(Session).where(Session.id == sid).values(revision=56))
        clock.now += timedelta(minutes=10)
        result = await send(client, sid, "What did you tell me about a quasicrystal?")
        assert result["evidence_mode"] == "historical"
        assert "aperiodic order" in result["answer"]


async def test_candidate_fallback_without_fts(settings, clock):
    # Simulate a SQLite build without FTS. Dropping only the indexes/triggers should not
    # change retrieval of a relevant recent turn.
    app = app_for(settings, clock, FakeModel(answers=[draft("Aperiodic order.")]), FakeSearch())
    async with app.router.lifespan_context(app), client_for(app) as client:
        async with app.state.db.begin() as db:
            for table in ("turns", "snapshots"):
                for suffix in ("insert", "delete", "update"):
                    await db.execute(text(f"DROP TRIGGER IF EXISTS {table}_fts_{suffix}"))
                await db.execute(text(f"DROP TABLE IF EXISTS {table}_fts"))
        sid = await session(client)
        await send(client, sid, "What is a quasicrystal?")
        answer = await send(client, sid, "What did you tell me about a quasicrystal?")
        assert "Aperiodic order." in answer["answer"]
        assert answer["evidence_mode"] == "historical"


async def test_fresh_followup_can_resolve_subject_from_conversation(settings, clock):
    hit = release(clock, "3.14.0")
    model = FakeModel(
        answers=[draft("Python releases feature updates annually."), release_draft(hit)],
        tools=[tool()],
        resolutions=[Resolution(snapshot_id=None, public_topic="Python", needs_search=True)],
    )
    app = app_for(settings, clock, model, FakeSearch([hit]))
    async with app.router.lifespan_context(app), client_for(app) as client:
        sid = await session(client)
        await send(client, sid, "Explain Python's release cycle.")
        current = await send(client, sid, "What is its latest release?")
        assert current["evidence_mode"] == "live_snippets"
        assert current["memory_used"]
        assert model.tool_contexts[0]["public_topic"] == "Python"
        assert "conversation" not in model.tool_contexts[0]


async def test_hallucinated_grounded_prose_is_never_returned(settings, clock):
    hit = release(clock, "3.14.0")
    answer = draft(
        "Get a fake release at https://hallucinated.example",
        excerpts=[Witness(source_id="R1", quote="This entire claim was invented by the model.")],
    )
    app = app_for(settings, clock, FakeModel(answers=[answer], tools=[tool()]), FakeSearch([hit]))
    async with app.router.lifespan_context(app), client_for(app) as client:
        response = await send(client, await session(client), "Latest Python release?")
        assert response["evidence_mode"] == "insufficient"
        assert response["search_status"] == "unsupported"
        assert not response["citations"] and "hallucinated.example" not in response["answer"]


async def test_owner_boundary(settings, clock):
    app = app_for(settings, clock, FakeModel(), FakeSearch())
    async with app.router.lifespan_context(app), client_for(app) as client:
        sid = await session(client)
        app.dependency_overrides[demo_identity] = lambda: "different-owner"
        assert (await client.get("/api/v1/sessions")).json() == []
        assert (await client.get(f"/api/v1/sessions/{sid}/messages")).status_code == 404
        assert (
            await client.post(
                "/api/v1/chat",
                json={
                    "session_id": sid,
                    "message": "Hi",
                },
            )
        ).status_code == 404


async def test_history_keeps_user_and_assistant_roles_separate(settings, clock):
    app = app_for(settings, clock, FakeModel(answers=[draft("Assistant response.")]), FakeSearch())
    async with app.router.lifespan_context(app), client_for(app) as client:
        sid = await session(client)
        await send(client, sid, "Explain a quasicrystal.")
        recalled = await send(client, sid, "What did I ask?")
        assert "you wrote:" in recalled["answer"]
        assert "Explain a quasicrystal." in recalled["answer"]
        assert "Assistant response." not in recalled["answer"]
