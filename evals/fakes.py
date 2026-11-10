import asyncio
import json
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime

from echo.errors import ModelUnavailable, SearchUnavailable
from echo.evidence import FactDraft, Witness
from echo.llm import Draft, Resolution, ToolCall
from echo.memory import MemoryCandidate
from echo.search import SearchResult


@dataclass
class Clock:
    now: datetime = datetime(2026, 1, 5, 12, tzinfo=UTC)

    def __call__(self):
        return self.now


def tool(query="Python latest stable release", max_results=4):
    return ToolCall(
        name="web_search",
        arguments=json.dumps(
            {
                "query": query,
                "max_results": max_results,
            }
        ),
    )


def draft(answer="", *, facts=(), excerpts=(), memories=()):
    return Draft(answer=answer, excerpts=list(excerpts), facts=list(facts), memories=list(memories))


def release(clock, value, site="python.example", subject="Python"):
    return SearchResult(
        title=f"{subject} releases",
        url=f"https://{site}/{value}",
        snippet=f"The latest stable {subject} release is {value}.",
        published_at=None,
        retrieved_at=clock(),
    )


def release_draft(*hits):
    facts = [
        FactDraft(
            subject=hit.title.removesuffix(" releases"),
            attribute="stable release",
            value=hit.url.rsplit("/", 1)[1],
            witness=Witness(source_id=f"R{index}", quote=hit.snippet),
        )
        for index, hit in enumerate(hits, 1)
    ]
    return draft(facts=facts)


def interview(quote, previous=None):
    return MemoryCandidate(kind="plan", key="interview", quote=quote, replaces_id=previous)


class FakeSearch:
    def __init__(self, *batches):
        self.batches = deque(batches)
        self.calls = []

    async def search(self, query, max_results):
        self.calls.append((query, max_results))
        if not self.batches:
            raise AssertionError("Unexpected web search")
        batch = self.batches.popleft()
        if batch == "fail":
            raise SearchUnavailable("Sanitized fixture outage")
        if batch == "stall":
            await asyncio.Event().wait()
        return batch


class FakeModel:
    def __init__(self, *, answers=(), tools=(), resolutions=()):
        self.answers = deque(answers)
        self.tools = deque(tools)
        self.resolutions = deque(resolutions)
        self.tool_contexts = []
        self.answer_contexts = []
        self.resolve_contexts = []

    @staticmethod
    async def _next(queue, context, what):
        if not queue:
            raise AssertionError(f"Unexpected model {what} call")
        reply = queue.popleft()
        if reply == "fail":
            raise ModelUnavailable("Fixture model unavailable")
        if callable(reply):
            reply = reply(context)
        if asyncio.iscoroutine(reply):
            reply = await reply
        return reply, 10

    async def tool_call(self, context):
        self.tool_contexts.append(context)
        value, tokens = await self._next(self.tools, context, "tool")
        return value if isinstance(value, list) else [value], tokens

    async def answer(self, context):
        self.answer_contexts.append(context)
        return await self._next(self.answers, context, "answer")

    async def resolve(self, context):
        self.resolve_contexts.append(context)
        value, tokens = await self._next(self.resolutions, context, "resolve")
        return value if isinstance(value, Resolution) else Resolution(
            snapshot_id=value,
            public_topic=None,
            needs_search=False,
        ), tokens
