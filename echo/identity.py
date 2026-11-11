import hmac
import re
from uuid import uuid4

from starlette.datastructures import MutableHeaders
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

COOKIE = "__Host-echo-visitor"
VISITOR = re.compile(r"[0-9a-f]{32}")


def signature(key: bytes, visitor: str) -> str:
    return hmac.digest(key, visitor.encode("ascii"), "sha256").hex()


class BrowserIdentity:
    def __init__(self, app: ASGIApp, *, key: bytes):
        self.app = app
        self.key = key

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_response(message: Message) -> None:
            if message["type"] == "http.response.start":
                state = scope.get("state", {})
                if state.get("browser_identity"):
                    headers = MutableHeaders(scope=message)
                    headers["cache-control"] = "private, no-store"
                    if cookie := state.get("browser_cookie"):
                        response = Response()
                        response.set_cookie(
                            COOKIE,
                            cookie,
                            max_age=90 * 86400,
                            secure=True,
                            httponly=True,
                            samesite="lax",
                        )
                        headers.append("set-cookie", response.headers["set-cookie"])
            await send(message)

        await self.app(scope, receive, send_response)


def browser_identity(request: Request, key: bytes) -> str:
    visitor, _, supplied = request.cookies.get(COOKIE, "").partition(".")
    if not (
        VISITOR.fullmatch(visitor)
        and len(supplied) == 64
        and supplied.isascii()
        and hmac.compare_digest(supplied, signature(key, visitor))
    ):
        visitor = uuid4().hex
        request.state.browser_cookie = visitor + "." + signature(key, visitor)
    request.state.browser_identity = True
    return "browser:" + visitor
