from collections import defaultdict
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Request, Response

from .auth import (COOKIE, SESSION_SECONDS, ApiError, admin_user, create_invite,
                   current_user, log_in, normalize_invite, session_hash)
from .db import money, new_id, now
from .room import Room, initial_state
from .schemas import InviteInput, Login, MemberInput, MemberPatch, RoomInput


api = APIRouter(prefix="/api")

SAMPLE_MEMBERS = [
    ("claude", "Claude", "C", "#C9842F", "anthropic/claude-haiku-5-5", "产品顾问", "先判断用户需要解决的问题，再给建议。"),
    ("gpt", "GPT", "G", "#14996F", "openai/gpt-5", "工程评估", "评估实现难度、时间和维护成本。"),
    ("gemini", "Gemini", "Ge", "#3C78F0", "gemini/gemini-3.5-flash-lite", "用户研究", "区分已知事实和待验证的假设。"),
    ("deepseek", "DeepSeek", "D", "#36458F", "deepseek/deepseek-flash", "唱反调", "找出前面观点中最薄弱的地方。"),
    ("qwen", "Qwen", "Q", "#8659E8", "dashscope/qwen-max", "中文写作", "用简洁准确的中文写作。"),
    ("llama", "Llama 本地", "L", "#6A6A70", "ollama/llama3.1:8b", "草稿员", "给出可迭代的第一版草案。"),
]

MODEL_LABELS = {
    "anthropic/claude-haiku-5-5": "Claude Haiku 5.5",
    "anthropic/claude-sonnet-5-5": "Claude Sonnet 5.5",
    "anthropic/claude-opus-5-5": "Claude Opus 5.5",
    "openai/gpt-5": "GPT-5",
    "openai/gpt-5-mini": "GPT-5 mini",
    "openai/gpt-5-nano": "GPT-5 nano",
    "gemini/gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
    "gemini/gemini-3.6-flash": "Gemini 3.6 Flash",
    "gemini/gemini-3.8-flash": "Gemini 3.8 Flash",
    "deepseek/deepseek-flash": "DeepSeek Flash",
    "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro",
    "dashscope/qwen-max": "Qwen Max",
    "dashscope/qwen-plus": "Qwen Plus",
    "dashscope/qwen-turbo": "Qwen Turbo",
    "ollama/llama3.1:8b": "Llama 3.1 8B（本地）",
}


def seed_members(db):
    for key, name, short, color, model, role, prompt in SAMPLE_MEMBERS:
        member = dict(id=f"ai_{key}", name=name, short=short, color=color, model=model, role=role,
                      system_prompt=prompt, temperature=0.5, max_chars=300,
                      monthly_budget_cny=None, can_mention=False)
        db.put("members", member["id"], member)


@api.post("/auth/login")
async def login(data: Login, request: Request, response: Response):
    state = request.app.state
    user, token = log_in(state.db, state.settings.admin_code, data.invite_code, data.name,
                         state.settings.monthly_user_limit)
    response.set_cookie(COOKIE, token, max_age=SESSION_SECONDS, httponly=True,
                        secure=state.settings.secure_cookie, samesite="lax")
    return user


@api.get("/auth/me")
async def me(user=Depends(current_user)):
    return user


@api.post("/auth/logout", status_code=204, dependencies=[Depends(current_user)])
async def logout(request: Request):
    token = request.cookies.get(COOKIE)
    if token:
        db = request.app.state.db
        with db.transaction():
            db.delete("sessions", session_hash(token))
    response = Response(status_code=204)
    response.delete_cookie(COOKIE, httponly=True, secure=request.app.state.settings.secure_cookie)
    return response


@api.get("/invites", dependencies=[Depends(admin_user)])
async def invites(request: Request):
    return sorted(request.app.state.db.list("invites"), key=lambda item: item["created_at"], reverse=True)


@api.post("/invites", dependencies=[Depends(admin_user)])
async def invite(data: InviteInput, request: Request):
    state = request.app.state
    return create_invite(state.db, state.settings.admin_code, data.note)


@api.delete("/invites/{code}", status_code=204, dependencies=[Depends(admin_user)])
async def delete_invite(code: str, request: Request):
    db = request.app.state.db
    normalized = normalize_invite(code)
    entry = required(db, "invites", normalized, "邀请码不存在")
    if entry["used_by"]:
        raise ApiError(400, "invite_used", "已使用的邀请码不能作废")
    with db.transaction():
        db.delete("invites", normalized)
        db.put("revoked_invites", normalized, {"code": normalized})
    return Response(status_code=204)


@api.get("/users", dependencies=[Depends(current_user)])
async def users(request: Request):
    return request.app.state.db.list("users")


@api.get("/models", dependencies=[Depends(current_user)])
async def models(request: Request):
    state = request.app.state
    catalog = dict(MODEL_LABELS)
    catalog.update({item["model"]: catalog.get(item["model"], item["model"].split("/", 1)[-1])
                    for item in state.db.list("members")})
    options = []
    providers = {}
    for model, label in catalog.items():
        provider = model.partition("/")[0]
        if provider not in providers:
            providers[provider] = state.settings.fake or state.llm.provider_available(model, provider)
        options.append(dict(id=model, label=label, provider=provider, available=providers[provider]))
    return options


def required(db, collection, key, message):
    item = db.get(collection, key)
    if not item:
        raise ApiError(404, "not_found", message)
    return item


def member_view(db, member):
    return dict(member, month_cost_cny=float(db.monthly_cost(member=member["id"])))


def member_fields(data, *, exclude_unset=False):
    result = data.model_dump(exclude_unset=exclude_unset)
    if result.get("monthly_budget_cny") is not None:
        result["monthly_budget_cny"] = float(money(result["monthly_budget_cny"]))
    return result


@api.get("/members", dependencies=[Depends(current_user)])
async def members(request: Request):
    db = request.app.state.db
    return [member_view(db, item) for item in db.list("members")]


@api.post("/members", dependencies=[Depends(admin_user)])
async def create_member(data: MemberInput, request: Request):
    db = request.app.state.db
    member = dict(id=new_id("ai"), **member_fields(data))
    with db.transaction():
        db.put("members", member["id"], member)
    return member_view(db, member)


@api.patch("/members/{member_id}", dependencies=[Depends(admin_user)])
async def update_member(member_id: str, data: MemberPatch, request: Request):
    db = request.app.state.db
    member = required(db, "members", member_id, "成员不存在")
    member.update(member_fields(data, exclude_unset=True))
    with db.transaction():
        db.put("members", member_id, member)
    return member_view(db, member)


@api.delete("/members/{member_id}", status_code=204, dependencies=[Depends(admin_user)])
async def delete_member(member_id: str, request: Request):
    db = request.app.state.db
    required(db, "members", member_id, "成员不存在")
    with db.transaction():
        db.delete("members", member_id)
    return Response(status_code=204)


def assign_duties(mode, ids, given):
    count = len(ids)
    defaults = {
        "round": ["speaker"] * count,
        "pipe": ["planner", "executor"] if count == 2 else ["planner"] + ["executor"] * (count - 2) + ["reviewer"],
        "cross": ["answerer"] * (count - 1) + ["judge"],
        "debate": ["pro" if index % 2 == 0 else "con" for index in range(count - 1)] + ["judge"],
    }
    allowed = {
        "round": {"speaker", "summarizer"}, "pipe": {"planner", "executor", "reviewer"},
        "cross": {"answerer", "judge"}, "debate": {"pro", "con", "judge"},
    }[mode]
    if given.keys() - set(ids) or set(given.values()) - allowed:
        raise ApiError(400, "invalid_duties", "职责与成员或房间模式不匹配")
    duties = dict(zip(ids, defaults[mode])) | given
    values = list(duties.values())
    if mode == "round" and values.count("summarizer") > 1:
        raise ApiError(400, "invalid_duties", "圆桌只能指定一位汇总者")
    if mode == "debate" and (not allowed.issubset(values) or values.count("judge") != 1):
        raise ApiError(400, "invalid_duties", "辩论需要正方、反方各至少一位及一位裁判")
    if mode == "cross" and (values.count("judge") != 1 or "answerer" not in values):
        raise ApiError(400, "invalid_duties", "交叉验证需要一位主席和至少一位回答者")
    if mode == "pipe" and (values.count("planner") != 1 or "executor" not in values or
                            (count > 2 and values.count("reviewer") != 1)):
        raise ApiError(400, "invalid_duties", "流水线需要规划者、执行者和审查者")
    return duties


def seat(person, duty=None):
    return {key: person[key] for key in ("id", "name", "short", "color")} | dict(
        kind="ai" if duty else "human", duty=duty, role=person.get("role"),
    )


@api.get("/rooms", dependencies=[Depends(current_user)])
async def rooms(request: Request):
    ordered = sorted(request.app.state.db.list("rooms"), key=lambda room: room["updated_at"], reverse=True)
    return [{key: value for key, value in room.items() if key not in {"topic", "rounds"}} for room in ordered]


@api.post("/rooms")
async def create_room(data: RoomInput, request: Request, user=Depends(current_user)):
    state = request.app.state
    db = state.db
    ids = data.ai_member_ids
    if len(ids) < 2 or len(set(ids)) != len(ids):
        raise ApiError(400, "invalid_members", "请选择至少两位不同的 AI 成员")
    duties = assign_duties(data.mode, ids, data.duties)
    ai_members = [db.get("members", member_id) for member_id in ids]
    other_users = [db.get("users", user_id) for user_id in dict.fromkeys(data.human_user_ids)
                   if user_id != user["id"]]
    if None in ai_members or None in other_users:
        raise ApiError(400, "invalid_members", "选择的成员不存在")
    record = dict(id=new_id("r"), title=(data.title or "").strip() or data.topic[:30],
                  topic=data.topic, rounds=data.rounds, mode=data.mode, status="idle",
                  seats=[seat(user), *[seat(person) for person in other_users],
                         *[seat(person, duties[person["id"]]) for person in ai_members]],
                  last_preview="", updated_at=now().isoformat(), cost_cny=0,
                  budget_cny=float(money(data.budget_cny)), created_by=user["id"])
    with db.transaction():
        db.put("rooms", record["id"], record)
        db.put("room_members", record["id"], ai_members)
        db.put("room_states", record["id"], initial_state(record))
    if data.auto_start:
        runtime = state.rooms[record["id"]] = Room(db, dict(record), state.llm)
        runtime.start()
    return record


@api.get("/rooms/{room_id}", dependencies=[Depends(current_user)])
async def room(room_id: str, request: Request):
    return required(request.app.state.db, "rooms", room_id, "房间不存在")


@api.delete("/rooms/{room_id}", status_code=204)
async def delete_room(room_id: str, request: Request, user=Depends(current_user)):
    state = request.app.state
    record = required(state.db, "rooms", room_id, "房间不存在")
    if not user["is_admin"] and record["created_by"] != user["id"]:
        raise ApiError(403, "forbidden", "只有创建者或管理员可以删除房间")
    runtime = state.rooms.get(room_id)
    if runtime:
        runtime.deleting = True
        await runtime.stop()
        state.rooms.pop(room_id, None)
    state.db.delete_room(room_id)
    return Response(status_code=204)


@api.get("/usage", dependencies=[Depends(current_user)])
async def usage(request: Request, range: Literal["week", "month", "all"] = "month"):
    db = request.app.state.db
    today = now().date()
    since = {"week": (today - timedelta(days=6)).isoformat(),
             "month": today.replace(day=1).isoformat(), "all": ""}[range]
    days = defaultdict(lambda: defaultdict(int))
    users = defaultdict(int)
    rooms = defaultdict(int)
    total = tokens_in = tokens_out = 0
    for date, room_id, member_id, user_id, amount, input_count, output_count in db.charges(since):
        total += amount
        tokens_in += input_count
        tokens_out += output_count
        days[date][member_id] += amount
        users[user_id] += amount
        rooms[room_id] += amount
    by_room = []
    for room_id, amount in sorted(rooms.items(), key=lambda item: item[1], reverse=True):
        room = db.get("rooms", room_id)
        if room:
            by_room.append(dict(room_id=room_id, title=room["title"], mode=room["mode"],
                                cost_cny=amount / 10000, budget_cny=room["budget_cny"]))
    return dict(range=range, total_cny=total / 10000, team_budget_cny=None,
                tokens_in=tokens_in, tokens_out=tokens_out,
                by_day=[dict(date=date, by_member={key: amount / 10000 for key, amount in costs.items()})
                        for date, costs in days.items()],
                by_user=[dict(user_id=user["id"], cost_cny=users[user["id"]] / 10000,
                              limit_cny=user["monthly_limit_cny"]) for user in db.list("users")],
                by_room=by_room[:5])
