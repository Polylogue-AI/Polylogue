import re
import secrets
from datetime import datetime, timedelta
from hashlib import sha256

from fastapi import Depends, Request

from .db import new_id, now


COOKIE = "rt_session"
SESSION_SECONDS = 30 * 24 * 60 * 60
INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def normalize_invite(code):
    code = code.strip()
    if not re.fullmatch(f"[{INVITE_ALPHABET}]{{6}}", code, re.ASCII | re.IGNORECASE):
        raise ApiError(400, "invalid_invite", "邀请码必须是六位有效字符")
    return code.upper()


def new_user(name, *, admin=False, monthly_limit=None):
    colors = ["#FFD8A8", "#B2F2BB", "#BAC8FF", "#FFD6E7", "#99E9F2"]
    return dict(id=new_id("u"), name=name, short=name[:2], color=secrets.choice(colors),
                is_admin=admin, monthly_limit_cny=monthly_limit)


def session_hash(token):
    return sha256(token.encode()).hexdigest()


def get_session(db, token):
    if token:
        session = db.get("sessions", session_hash(token))
        if session and datetime.fromisoformat(session["expires_at"]) > now():
            return db.get("users", session["user_id"])
    return None


async def current_user(request: Request):
    user = get_session(request.app.state.db, request.cookies.get(COOKIE))
    if not user:
        raise ApiError(401, "unauthorized", "请先登录")
    return user


async def admin_user(user=Depends(current_user)):
    if not user["is_admin"]:
        raise ApiError(403, "forbidden", "需要管理员权限")
    return user


def log_in(db, admin_code, code, name, monthly_limit=None):
    code = normalize_invite(code)
    admin = secrets.compare_digest(code, admin_code)
    with db.transaction():
        if admin:
            binding = db.get("admin_binding", code)
            invite = binding or {"used_by": None}
        else:
            invite = db.get("invites", code)
            if not invite:
                raise ApiError(400, "invalid_invite", "邀请码不存在")
        if invite["used_by"]:
            user = db.get("users", invite["used_by"])
            if user["name"] != name:
                raise ApiError(400, "invite_used", "邀请码已绑定其他名字")
        elif admin:
            seeded = db.get("settings", "seed_admin")
            user = db.get("users", seeded) if seeded else new_user(name, admin=True, monthly_limit=monthly_limit)
            user.update(name=name, short=name[:2], is_admin=True)
            db.delete("settings", "seed_admin")
            db.put("users", user["id"], user)
            db.put("admin_binding", code, {"used_by": user["id"]})
        else:
            if datetime.fromisoformat(invite["expires_at"]) <= now():
                raise ApiError(400, "invite_expired", "邀请码已过期")
            user = new_user(name, monthly_limit=monthly_limit)
            db.put("users", user["id"], user)
            db.put("invites", code, dict(invite, used_by=user["id"]))
        token = secrets.token_urlsafe(32)
        db.put("sessions", session_hash(token), dict(user_id=user["id"],
               expires_at=(now() + timedelta(seconds=SESSION_SECONDS)).isoformat()))
    return user, token


def create_invite(db, admin_code, note):
    instant = now()
    while True:
        code = "".join(secrets.choice(INVITE_ALPHABET) for _ in range(6))
        if code != admin_code and db.get("invites", code) is None and db.get("revoked_invites", code) is None:
            break
    invite = dict(code=code, note=note, created_at=instant.isoformat(),
                  expires_at=(instant + timedelta(days=7)).isoformat(), used_by=None)
    with db.transaction():
        db.put("invites", code, invite)
    return invite
