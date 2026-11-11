from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    event,
)
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator


class UTCDateTime(TypeDecorator):
    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("Expected a timezone-aware datetime")
        return value.astimezone(UTC)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


class Base(DeclarativeBase):
    pass


class Session(Base):
    __tablename__ = "sessions"
    __table_args__ = (Index("ix_sessions_user_created", "user_id", "created_at", "id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(128))
    title: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime)
    revision: Mapped[int] = mapped_column(Integer, default=0)


class Turn(Base):
    """A completed exchange. Both message IDs are first-class and stable."""

    __tablename__ = "turns"
    __table_args__ = (
        UniqueConstraint("session_id", "sequence", name="uq_turn_sequence"),
        UniqueConstraint("session_id", "request_id", name="uq_turn_request"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    request_id: Mapped[str | None] = mapped_column(String(36))
    sequence: Mapped[int] = mapped_column(Integer)
    user_message_id: Mapped[str] = mapped_column(String(36), unique=True)
    question: Mapped[str] = mapped_column(Text)
    asked_at: Mapped[datetime] = mapped_column(UTCDateTime)
    answered_at: Mapped[datetime] = mapped_column(UTCDateTime)
    response: Mapped[dict] = mapped_column(JSON)


class Memory(Base):
    __tablename__ = "memories"
    __table_args__ = (
        UniqueConstraint("user_id", "active_key", name="uq_memory_active_slot"),
        Index("ix_memories_user_observed", "user_id", "observed_at", "id"),
        CheckConstraint(
            "(active_key IS NULL AND superseded_at IS NOT NULL) OR "
            "(active_key IS NOT NULL AND superseded_at IS NULL)",
            name="ck_memory_status",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(24))
    key: Mapped[str] = mapped_column(String(80))
    active_key: Mapped[str | None] = mapped_column(String(110))
    content: Mapped[str] = mapped_column(Text)
    observed_at: Mapped[datetime] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime)
    source_message_id: Mapped[str] = mapped_column(
        ForeignKey("turns.user_message_id", ondelete="CASCADE")
    )
    superseded_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    replaces_id: Mapped[str | None] = mapped_column(ForeignKey("memories.id"))


class Snapshot(Base):
    __tablename__ = "snapshots"
    __table_args__ = (
        Index("ix_snapshots_user_observed", "user_id", "retrieved_at", "id"),
        Index("ix_snapshots_session_observed", "session_id", "retrieved_at", "id"),
        Index("ix_snapshots_user_topic", "user_id", "topic_key", "retrieved_at"),
    )

    id: Mapped[str] = mapped_column(ForeignKey("turns.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(128))
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    question: Mapped[str] = mapped_column(Text)
    topic_key: Mapped[str] = mapped_column(String(180))
    search_query: Mapped[str] = mapped_column(String(400))
    asked_at: Mapped[datetime] = mapped_column(UTCDateTime)
    retrieved_at: Mapped[datetime] = mapped_column(UTCDateTime)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    answer_summary: Mapped[str] = mapped_column(Text)
    claims: Mapped[list] = mapped_column(JSON)
    sources: Mapped[list] = mapped_column(JSON)


def database_url(value: str):
    url = make_url(value)
    if url.drivername in {"postgres", "postgresql"}:
        url = url.set(drivername="postgresql+asyncpg")
    return url


def database(url: str):
    engine = create_async_engine(database_url(url), pool_pre_ping=True, hide_parameters=True)
    if engine.dialect.name == "sqlite":

        @event.listens_for(engine.sync_engine, "connect")
        def configure_sqlite(connection, _):
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.close()

    return engine, async_sessionmaker(engine, expire_on_commit=False)


def utcnow() -> datetime:
    return datetime.now(UTC)
