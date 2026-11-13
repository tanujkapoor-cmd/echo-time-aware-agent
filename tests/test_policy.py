import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from openai import AsyncOpenAI

from echo.config import Settings
from echo.errors import ModelUnavailable
from echo.evidence import FactDraft, Witness, compare, ground
from echo.llm import ChatCompletionsModel
from echo.routing import Route, decide, historical_window
from echo.schemas import ChangeKind
from echo.search import Freshness, SearchCache, TavilySearch
from tests.fakes import release


@pytest.mark.parametrize(
    ("query", "expected", "forced"),
    [
        ("What is a prime number?", Route.GENERAL, False),
        ("Who is Ada Lovelace?", Route.GENERAL, False),
        ("What is the latest stable Python release?", Route.FRESH, True),
        ("I want to know the latest Python release.", Route.FRESH, True),
        ("Python release version", Route.FRESH, False),
        ("How does version control work?", Route.GENERAL, False),
        ("Why is that?", Route.FOLLOWUP, False),
        ("What is my interview plan?", Route.FOLLOWUP, False),
        ("What did you tell me last week?", Route.HISTORY, False),
        ("Is that still accurate?", Route.COMPARE, True),
        ("Has anything changed?", Route.COMPARE, True),
    ],
)
def test_routing(query, expected, forced):
    policy = decide(query)
    assert (policy.route, policy.force_fresh) == (expected, forced)


def test_utc_windows():
    now = datetime(2026, 1, 5, 12, tzinfo=UTC)
    assert historical_window("last week", now) == (
        datetime(2025, 12, 29, tzinfo=UTC),
        datetime(2026, 1, 5, tzinfo=UTC),
    )
    assert historical_window("2 days ago", now)[0] == datetime(2026, 1, 3, tzinfo=UTC)


def test_freshness_and_cache_boundary(clock):
    policy = Freshness(Settings(_env_file=None, echo_ttl_release=12))
    received = clock()
    route = decide("Python release version")
    assert policy.reusable(route, received, received + timedelta(seconds=11))
    assert not policy.reusable(route, received, received + timedelta(seconds=12))
    assert not policy.reusable(route, received, received - timedelta(seconds=1))
    assert not policy.reusable(decide("latest Python release"), received, received)

    tick = 0.0
    cache = SearchCache(1, clock=lambda: tick)
    first = (release(clock, "3.14.0"),)
    cache.put(("one",), first, 5)
    tick = 4.99
    assert cache.get(("one",)) == first
    tick = 5.0
    assert cache.get(("one",)) is None
    cache.put(("one",), first, 5)
    cache.put(("two",), first, 5)
    assert cache.get(("one",)) is None
    assert cache.get(("two",)) == first


def fact(hit, id="R1", value="3.14.0", attribute="stable release"):
    return FactDraft(
        subject="Python",
        attribute=attribute,
        value=value,
        witness=Witness(source_id=id, quote=hit.snippet),
    )


def test_citations_require_provider_id_and_literal_witness(clock):
    hit = release(clock, "3.14.0")
    result = ground(
        [
            Witness(source_id="https://hallucinated.example", quote=hit.snippet),
            Witness(source_id="R1", quote="This sentence was fabricated."),
            Witness(source_id="R1", quote=hit.snippet),
        ],
        [fact(hit, value="3.14")],
        {"R1": hit},
        cached=True,
    )
    assert not result.claims  # prefix of a version number is not the quoted value
    assert len(result.citations) == 1
    assert result.citations[0].url == hit.url
    assert result.citations[0].provenance == "cached"
    assert result.citations[0].retrieved_at == hit.retrieved_at


def test_comparison_is_keyed_and_explicit_about_absence_and_conflict(clock):
    before = release(clock, "3.14.0")
    after = release(clock, "3.14.1")
    old = ground([], [fact(before)], {"R1": before}, False).claims
    now = ground([], [fact(after, value="3.14.1")], {"R1": after}, False).claims
    divergent = [*old, *now]
    assert compare(old, now)[0].kind == ChangeKind.CHANGED
    assert compare(old, old)[0].kind == ChangeKind.UNCHANGED
    assert compare(old, divergent)[0].kind == ChangeKind.CONFLICTING
    assert {item.kind for item in compare(old, [])} == {
        ChangeKind.INSUFFICIENT,
        ChangeKind.NOW_UNVERIFIED,
    }
    new_key = [now[0].model_copy(update={"attribute": "preview release"})]
    assert {item.kind for item in compare(old, new_key)} == {
        ChangeKind.INSUFFICIENT,
        ChangeKind.NOW_UNVERIFIED,
        ChangeKind.NEW,
    }


async def test_tavily_http_contract(clock):
    async def handler(request):
        assert request.url == "https://api.tavily.com/search"
        assert request.headers["authorization"] == "Bearer fixture"
        body = json.loads(request.content)
        assert body["max_results"] == 3 and body["include_published_date"] is True
        assert body["include_raw_content"] is False and body["include_answer"] is False
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "Trusted release notes",
                        "url": "https://python.example/",
                        "content": "The latest stable release is 3.14.0.",
                        "published_date": "Tue, 11 Mar 2025 17:00:00 GMT",
                    },
                    {"title": "Invalid URL", "url": "javascript:alert(1)", "content": "Unusable"},
                    None,
                ]
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        hits = await TavilySearch(client, "fixture", clock).search("Python release", 3)
    assert len(hits) == 1
    assert hits[0].published_at == datetime(2025, 3, 11, 17, tzinfo=UTC)
    assert hits[0].retrieved_at == clock()


@pytest.mark.parametrize(
    ("provider", "base_url", "model_name"),
    [
        ("openai", "https://api.openai.com/v1", "gpt-4o-mini"),
        ("groq", "https://api.groq.com/openai/v1", "openai/gpt-oss-20b"),
    ],
)
async def test_chat_completions_sdk_http_contract(provider, base_url, model_name):
    seen = []

    async def handler(request):
        assert str(request.url) == base_url + "/chat/completions"
        body = json.loads(request.content)
        assert body["model"] == model_name
        seen.append(body)
        if "tools" in body:
            assert [item["function"]["name"] for item in body["tools"]] == ["web_search"]
            assert body["parallel_tool_calls"] is False
            if provider == "groq":
                assert body["tool_choice"] == "required"
            message = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call_demo",
                        "type": "function",
                        "function": {
                            "name": "web_search",
                            "arguments": '{"query":"Python","max_results":4}',
                        },
                    }
                ],
            }
        else:
            assert body["response_format"]["type"] == "json_schema"
            message = {
                "role": "assistant",
                "content": json.dumps(
                    {
                        "answer": "Hello",
                        "excerpts": [],
                        "facts": [],
                        "memories": [],
                    }
                ),
            }
        return httpx.Response(
            200,
            json={
                "id": "test",
                "object": "chat.completion",
                "created": 0,
                "model": model_name,
                "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
            },
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    async with AsyncOpenAI(
        api_key="fixture", base_url=base_url, http_client=http, max_retries=0
    ) as client:
        model = ChatCompletionsModel(client, model_name, timeout=10, provider=provider)
        calls, tokens = await model.tool_call({"question": "What is the latest Python?"})
        answer, _ = await model.answer({"question": "Hi"})
    assert calls[0].name == "web_search" and tokens == 10
    assert answer.answer == "Hello" and len(seen) == 2
    if provider == "groq":
        assert all("store" not in body and body["reasoning_effort"] == "low" for body in seen)
    else:
        assert all(body["store"] is False for body in seen)


@pytest.mark.parametrize("provider", ["openai", "groq"])
async def test_missing_model_key_is_explicit(provider):
    with pytest.raises(ModelUnavailable, match=f"{provider.upper()}_API_KEY"):
        await ChatCompletionsModel(None, "unused", 1, provider).answer({"question": "Hi"})
