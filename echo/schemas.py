from datetime import datetime
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class CreateSession(Input):
    title: str | None = Field(default=None, min_length=1, max_length=120)


class SessionView(BaseModel):
    id: UUID
    title: str | None
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class ChatInput(Input):
    session_id: UUID
    message: str = Field(min_length=1, max_length=4000)
    request_id: UUID | None = None


class SearchStatus(StrEnum):
    NOT_USED = "not_used"
    LIVE = "live"
    CACHED = "cached"
    UNAVAILABLE = "unavailable"
    EMPTY = "empty"
    UNSUPPORTED = "unsupported"


class EvidenceMode(StrEnum):
    MODEL_KNOWLEDGE = "model_knowledge"
    CONVERSATION = "conversation"
    HISTORICAL = "historical"
    LIVE_SNIPPETS = "live_snippets"
    CACHED_SNIPPETS = "cached_snippets"
    INSUFFICIENT = "insufficient"


class Citation(BaseModel):
    id: str
    title: str
    url: str
    quote: str
    published_at: datetime | None
    retrieved_at: datetime
    provenance: Literal["live", "cached", "historical"]


class Claim(BaseModel):
    subject: str
    attribute: str
    value: str
    observed_at: datetime
    source_url: str
    quote: str
    evidence_status: Literal["snippet_supported"] = "snippet_supported"


class ChangeKind(StrEnum):
    CHANGED = "changed"
    UNCHANGED = "unchanged"
    NEW = "new"
    NOW_UNVERIFIED = "now_unverified"
    CONFLICTING = "conflicting"
    INSUFFICIENT = "insufficient"


class Change(BaseModel):
    subject: str | None = None
    attribute: str | None = None
    kind: ChangeKind
    previous: list[Claim] = Field(default_factory=list)
    current: list[Claim] = Field(default_factory=list)


class Timing(BaseModel):
    memory_ms: float = 0
    llm_ms: float = 0
    search_ms: float = 0
    model_calls: int = 0
    search_calls: int = 0
    provider_calls: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    tokens: int | None = None


class ChatView(BaseModel):
    message_id: UUID
    answer: str
    timestamp: datetime
    citations: list[Citation]
    web_search_used: bool
    memory_used: bool
    evidence_mode: EvidenceMode
    search_status: SearchStatus
    changes: list[Change]
    baseline_at: datetime | None
    trace_id: UUID
    elapsed_ms: float
    timing: Timing


class MessageView(BaseModel):
    id: UUID
    role: Literal["user", "assistant"]
    content: str
    timestamp: datetime
    response: ChatView | None = None


class MemoryKind(StrEnum):
    GOAL = "goal"
    PREFERENCE = "preference"
    PROJECT = "project"
    PLAN = "plan"
    COMMITMENT = "commitment"


class MemoryView(BaseModel):
    id: UUID
    kind: MemoryKind
    key: str
    content: str
    observed_at: datetime
    created_at: datetime
    source_message_ids: list[UUID]
    extraction_status: Literal["explicit_user_quote"] = "explicit_user_quote"
    active: bool
    superseded_at: datetime | None
    replaces_id: UUID | None
