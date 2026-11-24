import os
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

from dotenv import load_dotenv

from .auth import normalize_invite
from .db import money


@dataclass(frozen=True)
class Settings:
    database: str
    admin_code: str
    fake: bool = False
    fake_delay: float = 0.03
    usd_cny_rate: Decimal = Decimal("7.2")
    secure_cookie: bool = False
    monthly_user_limit: float | None = None
    extra_models: dict[str, str] = field(default_factory=dict)

    sandbox_enabled: bool = False
    sandbox_image: str = "roundtable-sandbox"
    sandbox_timeout: int = 20
    sandbox_max_parallel: int = 2
    sandbox_max_runs_per_turn: int = 5
    sandbox_memory: str = "512m"
    tool_models: frozenset[str] = frozenset()

    def __post_init__(self):
        if not 1 <= self.sandbox_timeout <= 60:
            raise ValueError("SANDBOX_TIMEOUT 必须为 1–60 秒")
        if min(self.sandbox_max_parallel, self.sandbox_max_runs_per_turn) < 1:
            raise ValueError("沙箱并发数和每轮次数必须至少为 1")

    @classmethod
    def load(cls):
        load_dotenv(Path.cwd() / ".env")
        mode = os.getenv("LLM_MODE", "real").lower()
        if mode not in {"fake", "real"}:
            raise ValueError("LLM_MODE 必须为 fake 或 real")
        code = os.getenv("ADMIN_INVITE_CODE", "TABLE2" if mode == "fake" else "")
        if not code:
            raise ValueError("请设置 ADMIN_INVITE_CODE")
        user_limit = os.getenv("DEFAULT_MONTHLY_LIMIT_CNY", "").strip()
        monthly_user_limit = float(money(user_limit)) if user_limit else None
        if monthly_user_limit is not None and monthly_user_limit < 0:
            raise ValueError("DEFAULT_MONTHLY_LIMIT_CNY 必须是非负金额")
        extra_models = {}
        for entry in os.getenv("EXTRA_MODELS", "").split(","):
            model, _, label = entry.partition("=")
            model = model.strip()
            if model:
                extra_models[model] = label.strip() or model.split("/", 1)[-1]
        return cls(
            database=os.getenv("DATABASE_PATH", "roundtable.db"),
            admin_code=normalize_invite(code), fake=mode == "fake",
            fake_delay=float(os.getenv("FAKE_LLM_DELAY", "0.03")),
            usd_cny_rate=Decimal(os.getenv("USD_CNY_RATE", "7.2")),
            secure_cookie=os.getenv("SESSION_COOKIE_SECURE", "0") == "1",
            monthly_user_limit=monthly_user_limit,
            extra_models=extra_models,
            sandbox_enabled=os.getenv("SANDBOX_ENABLED", "0") == "1",
            sandbox_image=os.getenv("SANDBOX_IMAGE", "roundtable-sandbox"),
            sandbox_timeout=int(os.getenv("SANDBOX_TIMEOUT", "20")),
            sandbox_max_parallel=int(os.getenv("SANDBOX_MAX_PARALLEL", "2")),
            sandbox_max_runs_per_turn=int(os.getenv("SANDBOX_MAX_RUNS_PER_TURN", "5")),
            sandbox_memory=os.getenv("SANDBOX_MEMORY", "512m"),
            tool_models=frozenset(part.strip() for part in os.getenv("TOOL_MODELS", "").split(",") if part.strip()),
        )
