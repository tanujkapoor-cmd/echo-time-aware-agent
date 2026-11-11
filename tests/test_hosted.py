import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from echo.db import database_url
from echo.identity import COOKIE
from echo.main import create_app
from evals.fakes import FakeModel, draft, interview

from .conftest import send, session


async def test_browser_cookie_isolates_history_memory_and_streams(settings, clock):
    configured = settings.model_copy(
        update={"echo_browser_secret": SecretStr("fixture-signing-secret")}
    )
    message = "My interview is on Friday."
    model = FakeModel(answers=[draft("Saved.", memories=[interview(message)]), draft("Hi.")])
    app = create_app(configured, model=model, clock=clock)
    transport = ASGITransport(app=app)
    base = "https://echo.test"
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=transport, base_url=base) as first,
        AsyncClient(transport=transport, base_url=base) as second,
    ):
        response = await first.get("/api/v1/sessions")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert all(
            attr in response.headers["set-cookie"] for attr in ("HttpOnly", "Secure", "Path=/")
        )
        session_id = await session(first)
        await send(first, session_id, message)
        assert len((await first.get("/api/v1/memories")).json()) == 1
        assert (await second.get("/api/v1/sessions")).json() == []
        assert (await second.get("/api/v1/memories")).json() == []
        assert (await second.get(f"/api/v1/sessions/{session_id}/messages")).status_code == 404
        assert (await first.get(f"/api/v1/sessions/{session_id}/messages")).status_code == 200
        second.cookies.clear()
        forged = first.cookies[COOKIE].split(".")[0] + "." + "0" * 64
        assert (
            await second.get("/api/v1/sessions", headers={"Cookie": f"{COOKIE}={forged}"})
        ).json() == []
        response = await first.post(
            "/api/v1/chat/stream", json={"session_id": session_id, "message": "Hello."}
        )
        assert response.status_code == 200
        assert "event: completed" in response.text
        assert response.headers["cache-control"] == "private, no-store"


def test_hosted_requires_signing_key_and_postgres(settings):
    configured = settings.model_copy(update={"echo_public_demo": True})
    with pytest.raises(ValueError, match="signing secret"):
        create_app(configured)
    configured = configured.model_copy(update={"echo_browser_secret": SecretStr("x" * 32)})
    with pytest.raises(ValueError, match="requires PostgreSQL"):
        create_app(configured)
    url = database_url("postgresql://echo:demo%21@db.internal/echo")
    assert (url.drivername, url.password) == ("postgresql+asyncpg", "demo!")
