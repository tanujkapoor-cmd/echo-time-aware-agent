import asyncio
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from time import monotonic
from typing import Protocol
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from echo.config import Settings
from echo.db import utcnow
from echo.errors import SearchUnavailable
from echo.routing import Decision, Volatility


class SearchInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    query: str = Field(min_length=1, max_length=400)
    max_results: int = Field(ge=1, le=6)


class SearchResult(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    url: str = Field(min_length=1, max_length=2048)
    snippet: str = Field(min_length=1, max_length=1800)
    published_at: datetime | None = None
    retrieved_at: datetime


class SearchProvider(Protocol):
    async def search(self, query: str, max_results: int) -> list[SearchResult]: ...


def publication_date(raw: object) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        date = datetime.fromisoformat(raw)
    except ValueError:
        try:
            date = parsedate_to_datetime(raw)
        except (TypeError, ValueError, OverflowError):
            return None
    return date.replace(tzinfo=UTC) if date.tzinfo is None else date.astimezone(UTC)


def public_link(value: str) -> bool:
    try:
        parts = urlsplit(value)
        return bool(
            parts.scheme in {"http", "https"}
            and parts.hostname
            and parts.username is None
            and not any(char.isspace() or ord(char) < 32 for char in value)
        )
    except ValueError:
        return False


class TavilySearch:
    def __init__(self, client: httpx.AsyncClient, key: str, clock: Callable[[], datetime] = utcnow):
        self.client = client
        self.key = key
        self.clock = clock

    async def search(self, query: str, max_results: int) -> list[SearchResult]:
        if not self.key:
            raise SearchUnavailable("Search is not configured")
        try:
            response = await self.client.post(
                "https://api.tavily.com/search",
                headers={"Authorization": "Bearer " + self.key},
                json={
                    "query": query,
                    "max_results": max_results,
                    "search_depth": "basic",
                    "include_published_date": True,
                    "include_raw_content": False,
                    "include_answer": False,
                },
            )
            response.raise_for_status()
            body = response.json()
            if not isinstance(body, dict) or not isinstance(body.get("results"), list):
                raise ValueError("Invalid search response")
        except (httpx.HTTPError, ValueError):
            raise SearchUnavailable("Search provider did not return usable results") from None
        retrieved = self.clock()
        hits = []
        seen = set()
        for raw in body["results"][:max_results]:
            if not isinstance(raw, dict):
                continue
            title, url, snippet = (raw.get(key) for key in ("title", "url", "content"))
            if not all(isinstance(value, str) and value.strip() for value in (title, url, snippet)):
                continue
            if url in seen or not public_link(url):
                continue
            try:
                hits.append(
                    SearchResult(
                        title=title.strip()[:240],
                        url=url,
                        snippet=snippet.strip()[:1800],
                        published_at=publication_date(raw.get("published_date")),
                        retrieved_at=retrieved,
                    )
                )
            except ValidationError:
                continue
            seen.add(url)
        return hits


class Freshness:
    def __init__(self, settings: Settings):
        self.ttls = {
            Volatility.NEWS: settings.echo_ttl_news,
            Volatility.MARKET: settings.echo_ttl_market,
            Volatility.RELEASE: settings.echo_ttl_release,
            Volatility.GENERAL: settings.echo_ttl_general,
        }

    def ttl(self, decision: Decision) -> int:
        return self.ttls[decision.volatility]

    def reusable(self, decision: Decision, retrieved_at: datetime, now: datetime) -> bool:
        return not decision.force_fresh and timedelta(0) <= now - retrieved_at < timedelta(
            seconds=self.ttl(decision)
        )


@dataclass(frozen=True)
class Batch:
    results: tuple[SearchResult, ...]
    cached: bool


class SearchCache:
    """Bounded per-process cache. Expiration is checked on reads and cannot slide."""

    def __init__(self, capacity: int, clock=monotonic):
        self.capacity = capacity
        self.clock = clock
        self.entries: OrderedDict[tuple, tuple[float, tuple[SearchResult, ...]]] = OrderedDict()

    def get(self, key: tuple):
        entry = self.entries.get(key)
        if entry is None:
            return None
        expires, hits = entry
        if self.clock() >= expires:
            del self.entries[key]
            return None
        self.entries.move_to_end(key)
        return hits

    def put(self, key: tuple, hits: tuple[SearchResult, ...], ttl: int):
        if not hits or not ttl or not self.capacity:
            return
        self.entries[key] = (self.clock() + ttl, hits)
        self.entries.move_to_end(key)
        if len(self.entries) > self.capacity:
            self.entries.popitem(last=False)


class SearchService:
    def __init__(self, provider: SearchProvider, settings: Settings, clock=utcnow):
        self.provider = provider
        self.cache = SearchCache(settings.echo_search_cache_size)
        self.freshness = Freshness(settings)
        self.timeout = settings.echo_search_timeout
        self.clock = clock

    async def run(self, user_id: str, args: SearchInput, decision: Decision, timing) -> Batch:
        key = (
            user_id,
            " ".join(args.query.casefold().split()),
            args.max_results,
            decision.volatility,
        )
        cached = None if decision.force_fresh else self.cache.get(key)
        if cached and all(
            self.freshness.reusable(decision, hit.retrieved_at, self.clock()) for hit in cached
        ):
            timing.cache_hits += 1
            return Batch(cached, cached=True)
        timing.cache_misses += 1
        timing.provider_calls += 1
        try:
            async with asyncio.timeout(self.timeout):
                hits = tuple(await self.provider.search(args.query, args.max_results))
        except TimeoutError:
            raise SearchUnavailable("Search timed out") from None
        self.cache.put(key, hits, self.freshness.ttl(decision))
        return Batch(hits, cached=False)
