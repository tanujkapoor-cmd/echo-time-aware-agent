import asyncio
from pathlib import Path

import pytest
from alembic.config import Config
from httpx import ASGITransport, AsyncClient

from alembic import command
from echo.config import Settings
from echo.main import create_app
from tests.fakes import Clock

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
async def settings(tmp_path, monkeypatch):
    url = "sqlite+aiosqlite:///" + (tmp_path / "test.db").as_posix()
    monkeypatch.setenv("ECHO_DATABASE_URL", url)
    config = Config(str(ROOT / "alembic.ini"))
    await asyncio.to_thread(command.upgrade, config, "head")
    return Settings(
        _env_file=None,
        echo_database_url=url,
        openai_api_key="",
        tavily_api_key="",
        echo_demo_user="test-demo",
        echo_log_level="ERROR",
    )


def app_for(settings, clock, model=None, search=None):
    return create_app(settings, model=model, provider=search, clock=clock)


async def session(client, title=None):
    response = await client.post("/api/v1/sessions", json={"title": title})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def client_for(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://echo.test")


async def send(client, session_id, message, **extra):
    response = await client.post(
        "/api/v1/chat",
        json={
            "session_id": session_id,
            "message": message,
            **extra,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()
