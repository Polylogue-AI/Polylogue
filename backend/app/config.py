import os
from dataclasses import dataclass
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
        return cls(
            database=os.getenv("DATABASE_PATH", "roundtable.db"),
            admin_code=normalize_invite(code), fake=mode == "fake",
            fake_delay=float(os.getenv("FAKE_LLM_DELAY", "0.03")),
            usd_cny_rate=Decimal(os.getenv("USD_CNY_RATE", "7.2")),
            secure_cookie=os.getenv("SESSION_COOKIE_SECURE", "0") == "1",
            monthly_user_limit=monthly_user_limit,
        )
