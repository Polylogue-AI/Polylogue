import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from .api import api, seed_members
from .auth import ApiError, new_user
from .config import Settings
from .db import Store, now
from .llm import FakeLLM, LiteLLM, anthropic_endpoint
from .sandbox import FakeSandbox, Sandbox
from .ws import ws


def create_app(settings: Settings | None = None, llm=None, sandbox=None):
    @asynccontextmanager
    async def lifespan(app):
        state = app.state
        state.settings = settings or Settings.load()
        settings_now = state.settings
        db = state.db = Store(settings_now.database)
        state.rooms = {}
        try:
            if settings_now.fake and not db.get("settings", "fake_seeded"):
                with db.transaction():
                    if not db.list("users"):
                        user = new_user("管理员", admin=True, monthly_limit=settings_now.monthly_user_limit)
                        db.put("users", user["id"], user)
                        db.put("settings", "seed_admin", user["id"])
                    if not db.list("members"):
                        seed_members(db)
                    db.put("settings", "fake_seeded", True)
            with db.transaction():
                for record in db.list("rooms"):
                    if record["status"] in {"running", "paused"}:
                        saved = db.get("room_states", record["id"])
                        saved.update(status="error", speaker_id=None, next_speaker_id=None)
                        db.put("room_states", record["id"], saved)
                        db.put("rooms", record["id"], dict(record, status="error", updated_at=now().isoformat()))
                    for message in db.messages(record["id"]):
                        if message["streaming"]:
                            if message["kind"] == "run":
                                message["meta"]["run"].update(status="cancelled", stderr="后端重启，运行已终止")
                                message["content"] = "后端重启，运行已终止。"
                            db.put_message(dict(message, streaming=False, interrupted=True))
            state.llm = llm if llm is not None else (FakeLLM(delay=settings_now.fake_delay) if settings_now.fake
                                                     else LiteLLM(settings_now.usd_cny_rate))
            state.sandbox = sandbox if sandbox is not None else (
                FakeSandbox(settings_now) if settings_now.fake else Sandbox(settings_now)
            )
            await state.sandbox.start()
            if isinstance(state.llm, LiteLLM):
                logging.getLogger("uvicorn.error").info("Anthropic API：%s", anthropic_endpoint())
            yield
        finally:
            await asyncio.gather(*(runtime.stop() for runtime in state.rooms.values()), return_exceptions=True)
            db.close()

    app = FastAPI(title="AI Roundtable", lifespan=lifespan)

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, exc: ApiError):
        return failure(exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, exc: RequestValidationError):
        field = "、".join(".".join(str(part) for part in item["loc"][1:]) for item in exc.errors())
        return failure(400, "invalid_request", f"请求字段无效：{field}")

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException):
        messages = {404: ("not_found", "接口不存在"), 405: ("method_not_allowed", "不支持该请求方法")}
        code, message = messages.get(exc.status_code, ("http_error", "请求失败"))
        return failure(exc.status_code, code, message)

    @app.exception_handler(Exception)
    async def server_error(_request: Request, _exc: Exception):
        return failure(500, "internal_error", "服务器暂时无法处理请求")

    app.include_router(api)
    app.include_router(ws)
    return app


def failure(status, code, message):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


app = create_app()
