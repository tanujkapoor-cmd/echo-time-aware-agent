"""Run fixture-backed behavioral evaluation against the migrated HTTP API."""

import asyncio
import json
import math
import os
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter

from alembic.config import Config
from httpx import ASGITransport, AsyncClient

from alembic import command
from echo.config import Settings
from echo.main import create_app
from evals.fakes import Clock, FakeModel, FakeSearch, draft, interview, release, release_draft, tool

ROOT = Path(__file__).resolve().parents[1]


def prepare(case):
    clock = Clock()
    setup = Clock()
    search_batches, calls, answers = [], [], []
    for turn in case["turns"]:
        setup.now += timedelta(days=turn.get("days", 0))
        if "hits" in turn:
            hits = [
                release(setup, value, f"release{index}.example")
                for index, value in enumerate(turn["hits"])
            ]
            search_batches.append(hits)
            calls.append(tool())
            answers.append(release_draft(*hits))
        elif turn.get("outage"):
            search_batches.append("fail")
            calls.append(tool())
        elif "reply" in turn:

            def respond(data, turn=turn):
                if turn.get("require_context"):
                    assert turn["require_context"] in [row["user"] for row in data["conversation"]]
                if turn.get("require_memory"):
                    assert turn["require_memory"] in [
                        row["quote"] for row in data["active_user_memories"]
                    ]
                candidates = []
                if turn.get("save"):
                    previous = (
                        data["active_user_memories"][0]["id"] if turn["save"] == "replace" else None
                    )
                    candidates.append(interview(turn["message"], previous))
                return draft(turn["reply"], memories=candidates)

            answers.append(respond)
    return clock, FakeModel(answers=answers, tools=calls), FakeSearch(*search_batches)


def checks(actual):
    return {
        "mode": lambda value: actual["evidence_mode"] == value,
        "providers": lambda value: actual["timing"]["provider_calls"] == value,
        "contains": lambda value: value in actual["answer"],
        "citations": lambda value: len(actual["citations"]) == value,
        "change": lambda value: value in {item["kind"] for item in actual["changes"]},
    }


def percentile(samples, fraction):
    return round(sorted(samples)[math.ceil(len(samples) * fraction) - 1], 2)


async def run(url):
    dataset = json.loads((ROOT / "evals" / "cases.json").read_text(encoding="utf-8"))
    samples = []
    reports = []
    providers = 0
    search_calls = 0
    for case in dataset:
        clock, model, search = prepare(case)
        settings = Settings(
            _env_file=None,
            echo_database_url=url,
            echo_log_level="ERROR",
            echo_demo_user=f"eval-{case['id']}",
        )
        app = create_app(settings, model=model, provider=search, clock=clock)
        failures = []
        async with (
            app.router.lifespan_context(app),
            AsyncClient(transport=ASGITransport(app=app), base_url="http://echo.test") as client,
        ):
            created = await client.post("/api/v1/sessions", json={"title": case["id"]})
            created.raise_for_status()
            sid = created.json()["id"]
            for index, step in enumerate(case["turns"], 1):
                clock.now += timedelta(days=step.get("days", 0))
                start = perf_counter()
                reply = await client.post(
                    "/api/v1/chat",
                    json={
                        "session_id": sid,
                        "message": step["message"],
                    },
                )
                samples.append((perf_counter() - start) * 1000)
                if reply.status_code != 200:
                    failures.append(f"turn {index}: HTTP {reply.status_code}")
                    break
                body = reply.json()
                providers += body["timing"]["provider_calls"]
                search_calls += body["timing"]["search_calls"]
                match = checks(body)
                failures.extend(
                    f"turn {index}: {key} != {value!r}"
                    for key, value in step["expect"].items()
                    if not match[key](value)
                )
            if "active_memory" in case:
                rows = (await client.get("/api/v1/memories?kind=plan")).json()
                if case["active_memory"] not in [row["content"] for row in rows]:
                    failures.append("corrected active memory missing")
        reports.append({"case": case["id"], "passed": not failures, "failures": failures})

    print(
        json.dumps(
            {
                "mode": "deterministic_fixtures",
                "cases_passed": sum(item["passed"] for item in reports),
                "cases_total": len(reports),
                "turns_measured": len(samples),
                "tool_search_calls": search_calls,
                "provider_calls": providers,
                "p50_ms": percentile(samples, 0.50),
                "p95_ms": percentile(samples, 0.95),
                "cases": reports,
            },
            indent=2,
        )
    )
    return 0 if all(item["passed"] for item in reports) else 1


def main():
    with TemporaryDirectory(prefix="echo-eval-") as tmp:
        url = "sqlite+aiosqlite:///" + (Path(tmp) / "eval.db").as_posix()
        old = os.environ.get("ECHO_DATABASE_URL")
        os.environ["ECHO_DATABASE_URL"] = url
        try:
            command.upgrade(Config(str(ROOT / "alembic.ini")), "head")
            return asyncio.run(run(url))
        finally:
            if old is None:
                os.environ.pop("ECHO_DATABASE_URL", None)
            else:
                os.environ["ECHO_DATABASE_URL"] = old


if __name__ == "__main__":
    raise SystemExit(main())
