import asyncio
import json
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from echo.db import Snapshot
from echo.llm import ToolCall
from evals.fakes import FakeModel, FakeSearch, draft, interview, release, release_draft, tool

from .conftest import app_for, client_for, send, session


async def test_foundation_restart_and_idempotency(settings, clock):
    model = FakeModel(answers=[draft("A prime has exactly two positive divisors.")])
    app = app_for(settings, clock, model, FakeSearch())
    request_id = str(uuid4())
    async with app.router.lifespan_context(app), client_for(app) as client:
        assert (await client.get("/api/v1/health")).json() == {"status": "ok"}
        sid = await session(client, "Mathematics")
        first = await send(client, sid, "What is a prime number?", request_id=request_id)
        assert first["timing"]["model_calls"] == 1
        assert not first["web_search_used"] and not first["memory_used"]
        assert first["evidence_mode"] == "model_knowledge"

    app = app_for(settings, clock, FakeModel(), FakeSearch())
    async with app.router.lifespan_context(app), client_for(app) as client:
        assert (await client.get("/api/v1/sessions")).json()[0]["title"] == "Mathematics"
        replay = await send(client, sid, "What is a prime number?", request_id=request_id)
        assert replay == first
        mismatch = await client.post(
            "/api/v1/chat",
            json={
                "session_id": sid,
                "message": "Another question",
                "request_id": request_id,
            },
        )
        assert mismatch.status_code == 409
        assert mismatch.json()["error"]["code"] == "request_id_conflict"
        history = (await client.get(f"/api/v1/sessions/{sid}/messages")).json()
        assert [item["role"] for item in history] == ["user", "assistant"]
        assert history[0]["timestamp"].endswith("Z")
        assert history[1]["response"] == first
        assert (await client.get(f"/api/v1/sessions/{sid}/messages?after=1")).json() == []
        assert "/api/v1/chat/stream" in (await client.get("/openapi.json")).json()["paths"]


async def test_new_version_preserves_old_snapshot_and_recall(settings, clock):
    old = release(clock, "3.14.0")
    clock.now += timedelta(days=5)
    new = release(clock, "3.14.1")
    clock.now = old.retrieved_at
    provider = FakeSearch([old], [new])
    model = FakeModel(answers=[release_draft(old), release_draft(new)], tools=[tool(), tool()])
    app = app_for(settings, clock, model, provider)
    async with app.router.lifespan_context(app), client_for(app) as client:
        sid = await session(client)
        first = await send(client, sid, "What is the latest stable Python release?")
        assert first["evidence_mode"] == "live_snippets"
        assert first["citations"][0]["url"] == old.url
        clock.now = new.retrieved_at
        later = await send(client, sid, "Has anything changed?")
        assert later["search_status"] == "live" and later["memory_used"]
        assert later["baseline_at"] == first["citations"][0]["retrieved_at"]
        assert later["changes"][0]["kind"] == "changed"
        assert "3.14.0 to 3.14.1" in later["answer"]
        assert "[H1] [S1]" in later["answer"].split("\n")[1]
        assert {item["provenance"] for item in later["citations"]} == {"live", "historical"}
        assert len(provider.calls) == 2
        assert (
            model.tool_contexts[-1]["prior_public_search_query"] == "Python latest stable release"
        )
        async with app.state.db() as db:
            snapshots = (await db.scalars(select(Snapshot).order_by(Snapshot.asked_at))).all()
            assert [item.claims[0]["value"] for item in snapshots] == ["3.14.0", "3.14.1"]
            assert snapshots[1].topic_key == snapshots[0].topic_key
        clock.now += timedelta(days=1)  # Jan 11, so "6 days ago" selects Jan 5 only.
        archived = await send(client, sid, "What did you tell me 6 days ago?")
        assert archived["evidence_mode"] == "historical"
        assert "3.14.0" in archived["answer"] and "3.14.1" not in archived["answer"]
        assert archived["citations"][0]["provenance"] == "historical"
        assert len(provider.calls) == 2


async def test_followup_without_search_and_ambiguous_research(settings, clock):
    hit = release(clock, "3.14.0")
    ruby = release(clock, "4.0.0", "ruby.example", "Ruby")
    provider = FakeSearch([hit], [ruby], [hit])
    model = FakeModel(
        answers=[
            release_draft(hit),
            release_draft(ruby),
            draft("The explanation."),
            release_draft(hit),
        ],
        tools=[tool(), tool("Ruby latest stable release"), tool()],
        resolutions=[
            None,
            lambda data: next(x["id"] for x in data["options"] if "python" in x["topic"]),
        ],
    )
    app = app_for(settings, clock, model, provider)
    async with app.router.lifespan_context(app), client_for(app) as client:
        sid = await session(client)
        await send(client, sid, "What is the latest stable Python release?")
        await send(client, sid, "What is the latest stable Ruby release?")
        explain = await send(client, sid, "Why is that?")
        assert explain["memory_used"] and not explain["web_search_used"]
        assert "Ruby" in model.answer_contexts[2]["conversation"][-1]["user"]
        later = await send(client, sid, "Has anything changed?")
        assert later["changes"][0]["kind"] == "unchanged"
        assert model.tool_contexts[-1]["prior_public_search_query"].startswith("Python")


async def test_saved_research_reuse_and_explicit_bypass(settings, clock):
    old = release(clock, "3.14.0")
    provider = FakeSearch([old], [old])
    model = FakeModel(answers=[release_draft(old)] * 3, tools=[tool(), tool()])
    app = app_for(settings, clock, model, provider)
    async with app.router.lifespan_context(app), client_for(app) as client:
        sid = await session(client)
        await send(client, sid, "Python release version")
        clock.now += timedelta(minutes=15)
        cached = await send(client, sid, "Python release version")
        assert not cached["web_search_used"]
        assert cached["search_status"] == "cached"
        assert cached["citations"][0]["retrieved_at"].startswith("2026-01-05T12:00")
        assert cached["timing"]["cache_hits"] == 1
        assert cached["timing"]["model_calls"] == 1
        checked = await send(client, sid, "Latest Python release version")
        assert checked["search_status"] == "live"
        assert len(provider.calls) == 2


async def test_memory_correction_and_dedup_across_sessions(settings, clock):
    friday = "My interview is on Friday."
    monday = "Actually, it was moved to Monday."

    def correction(data):
        current = data["active_user_memories"][0]
        assert current["quote"] == friday
        return draft("Monday.", memories=[interview(monday, current["id"])])

    def recall(data):
        assert [item["quote"] for item in data["active_user_memories"]] == [monday]
        return draft("Your interview is on Monday.")

    model = FakeModel(
        answers=[
            draft("Understood.", memories=[interview(friday)]),
            draft("Understood.", memories=[interview(friday)]),
            correction,
            recall,
        ]
    )
    app = app_for(settings, clock, model, FakeSearch())
    async with app.router.lifespan_context(app), client_for(app) as client:
        sid = await session(client)
        await send(client, sid, friday)
        await send(client, sid, friday)
        clock.now += timedelta(hours=1)
        second = await session(client)
        await send(client, second, monday)
        recall_reply = await send(client, second, "What is my interview plan?")
        assert recall_reply["answer"].endswith("Monday.")
        active = (await client.get("/api/v1/memories?kind=plan")).json()
        all_mem = (await client.get("/api/v1/memories?include_superseded=true")).json()
        assert len(active) == 1 and active[0]["content"] == monday
        assert len(all_mem) == 2 and all_mem[1]["content"] == friday and not all_mem[1]["active"]
        assert active[0]["replaces_id"] == all_mem[1]["id"]
        assert len(active[0]["source_message_ids"]) == 1


@pytest.mark.parametrize("failure", ["fail", "stall"])
async def test_failed_recheck_never_reports_no_change(settings, clock, failure):
    settings.echo_search_timeout = 0.02
    hit = release(clock, "3.14.0")
    provider = FakeSearch([hit], failure)
    model = FakeModel(answers=[release_draft(hit)], tools=[tool(), tool()])
    app = app_for(settings, clock, model, provider)
    async with app.router.lifespan_context(app), client_for(app) as client:
        sid = await session(client)
        await send(client, sid, "Latest Python release?")
        result = await send(client, sid, "Is that still accurate?")
        assert result["search_status"] == "unavailable"
        assert result["evidence_mode"] == "insufficient"
        assert "can't determine" in result["answer"]
        assert all(item["provenance"] == "historical" for item in result["citations"])
        assert {item["kind"] for item in result["changes"]} == {"insufficient", "now_unverified"}


async def test_search_limit_and_no_unlisted_tool_execution(settings, clock):
    provider = FakeSearch([], [])
    model = FakeModel(
        tools=[
            tool("Python release info"),
            tool("Python download latest stable"),
            ToolCall(name="not_a_tool", arguments='{"query":"bad","max_results":4}'),
        ]
    )
    app = app_for(settings, clock, model, provider)
    async with app.router.lifespan_context(app), client_for(app) as client:
        sid = await session(client)
        reply = await send(client, sid, "Latest Python release?")
        assert reply["search_status"] == "empty" and reply["timing"]["search_calls"] == 2
        assert "no usable results" in reply["answer"]
        rejected = await send(client, sid, "Latest Ruby release?")
        assert not rejected["web_search_used"] and rejected["timing"]["search_calls"] == 0
        assert len(provider.calls) == 2


async def test_conflicting_sources_are_reported(settings, clock):
    one = release(clock, "3.14.0")
    two = release(clock, "3.14.1", "another.example")
    app = app_for(
        settings,
        clock,
        FakeModel(answers=[release_draft(one, two)], tools=[tool()]),
        FakeSearch([one, two]),
    )
    async with app.router.lifespan_context(app), client_for(app) as client:
        result = await send(client, await session(client), "Latest Python release?")
        assert "excerpts disagree" in result["answer"]
        assert result["changes"][0]["kind"] == "conflicting"
        assert len(result["citations"]) == 2


def sse_events(response):
    return [
        (event.splitlines()[0].removeprefix("event: "), json.loads(event.splitlines()[1][6:]))
        for event in response.text.strip().split("\n\n")
    ]


async def test_sse_completion_and_failure(settings, clock):
    app = app_for(
        settings, clock, FakeModel(answers=[draft("A validated answer."), "fail"]), FakeSearch()
    )
    async with app.router.lifespan_context(app), client_for(app) as client:
        sid = await session(client)
        resp = await client.post(
            "/api/v1/chat/stream", json={"session_id": sid, "message": "Hello!"}
        )
        assert resp.headers["content-type"].startswith("text/event-stream")
        events = sse_events(resp)
        assert events[0][1]["stage"] == "receive_query"
        assert events[-1][0] == "completed" and events[-1][1]["ok"]
        assert (
            "".join(data["text"] for name, data in events if name == "token")
            == "A validated answer."
        )
        assert any(name == "sources" for name, _ in events)
        failure = await client.post(
            "/api/v1/chat/stream", json={"session_id": sid, "message": "Hello again!"}
        )
        events = sse_events(failure)
        assert [name for name, _ in events[-2:]] == ["error", "completed"]
        assert events[-2][1]["code"] == "model_unavailable"
        assert not events[-1][1]["ok"]
        assert len((await client.get(f"/api/v1/sessions/{sid}/messages")).json()) == 2


async def test_bad_inputs_and_missing_model(settings, clock):
    app = app_for(settings, clock, search=FakeSearch())
    async with app.router.lifespan_context(app), client_for(app) as client:
        bad = await client.post("/api/v1/chat", json={"session_id": "bad", "message": " "})
        assert bad.status_code == 422
        assert "input" not in bad.json()["error"]
        missing = await client.post(
            "/api/v1/chat", json={"session_id": str(uuid4()), "message": "Hello!"}
        )
        assert missing.status_code == 404
        sid = await session(client)
        unconfigured = await client.post(
            "/api/v1/chat", json={"session_id": sid, "message": "Hello!"}
        )
        assert unconfigured.status_code == 503
        assert unconfigured.json()["error"]["code"] == "model_unavailable"


async def test_concurrent_turns_cannot_commit_on_same_revision(settings, clock):
    ready = asyncio.Event()
    count = 0

    async def synchronized(_):
        nonlocal count
        count += 1
        if count == 2:
            ready.set()
        await asyncio.wait_for(ready.wait(), timeout=2)
        return draft("Completed.")

    app = app_for(settings, clock, FakeModel(answers=[synchronized, synchronized]), FakeSearch())
    async with app.router.lifespan_context(app), client_for(app) as client:
        sid = await session(client)
        outcomes = await asyncio.gather(
            *[
                client.post("/api/v1/chat", json={"session_id": sid, "message": text})
                for text in ("Message A", "Message B")
            ]
        )
        assert sorted(item.status_code for item in outcomes) == [200, 409]
        loser = next(item for item in outcomes if item.status_code == 409)
        assert loser.json()["error"]["code"] == "session_conflict"
        assert len((await client.get(f"/api/v1/sessions/{sid}/messages")).json()) == 2


async def test_cross_session_corrections_conflict_without_duplicate_active_memory(settings, clock):
    friday = "My interview is on Friday."
    ready = asyncio.Event()
    count = 0

    async def correction(data):
        nonlocal count
        original = data["active_user_memories"][0]
        assert original["quote"] == friday
        count += 1
        if count == 2:
            ready.set()
        await asyncio.wait_for(ready.wait(), timeout=2)
        return draft("Understood.", memories=[interview(data["question"], original["id"])])

    model = FakeModel(
        answers=[
            draft("Understood.", memories=[interview(friday)]),
            correction,
            correction,
        ]
    )
    app = app_for(settings, clock, model, FakeSearch())
    async with app.router.lifespan_context(app), client_for(app) as client:
        await send(client, await session(client), friday)
        clock.now += timedelta(hours=1)
        ids = [await session(client), await session(client)]
        turns = ["Actually, it moved to Monday.", "Actually, it moved to Tuesday."]
        outcomes = await asyncio.gather(
            *[
                client.post("/api/v1/chat", json={"session_id": sid, "message": message})
                for sid, message in zip(ids, turns, strict=True)
            ]
        )
        assert sorted(item.status_code for item in outcomes) == [200, 409]
        assert (
            next(item for item in outcomes if item.status_code == 409).json()["error"]["code"]
            == "memory_conflict"
        )
        records = (await client.get("/api/v1/memories?include_superseded=true")).json()
        assert len(records) == 2 and len([row for row in records if row["active"]]) == 1
        assert next(row for row in records if not row["active"])["content"] == friday
