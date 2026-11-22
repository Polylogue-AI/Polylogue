from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.llm import FakeLLM
from app.main import create_app


class RecordingLLM(FakeLLM):
    def __init__(self):
        super().__init__(delay=0.01)
        self.calls = []
        self.failures = 0

    async def stream_chat(self, model, messages, temperature, max_tokens):
        self.calls.append((model, messages))
        if self.failures:
            self.failures -= 1
            raise RuntimeError("模拟服务故障")
        return await super().stream_chat(model, messages, temperature, max_tokens)


@pytest.fixture
def server():
    fake = RecordingLLM()
    with TestClient(create_app(Settings(":memory:", "TABLE2", fake=True), fake)) as client:
        login = client.post("/api/auth/login", json={"invite_code": "table2", "name": "管理员"})
        assert login.status_code == 200, login.text
        assert "HttpOnly" in login.headers["set-cookie"] and "Max-Age=2592000" in login.headers["set-cookie"]
        assert client.get("/api/auth/me").json()["is_admin"] is True
        yield client, fake


def create_room(client, *, budget=1, users=(), auto_start=False, **extra):
    response = client.post("/api/rooms", json=dict(topic="怎么组织一次读书会？", mode="round", rounds=1,
                           ai_member_ids=["ai_claude", "ai_gemini", "ai_deepseek"], human_user_ids=list(users),
                           budget_cny=budget, auto_start=auto_start) | extra)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "idle"
    return f"/ws/rooms/{response.json()['id']}"


def guest_account(client):
    admin_token = client.cookies["rt_session"]
    invite = client.post("/api/invites", json={"note": "第二位参与者"}).json()
    guest = client.post("/api/auth/login", json={"invite_code": invite["code"].lower(), "name": "小雨"})
    assert guest.status_code == 200, guest.text
    token = guest.cookies["rt_session"]
    client.cookies.clear()
    client.cookies.set("rt_session", admin_token)
    return guest.json(), {"cookie": f"rt_session={token}"}, invite


def event(socket, kind, **matches):
    for _ in range(1000):
        item = socket.receive_json()
        if item["type"] == kind and all(item.get(key) == value for key, value in matches.items()):
            return item
    pytest.fail(f"未收到 {kind}")


def snapshot(socket, last_seq=0):
    socket.send_json({"type": "hello", "last_seq": last_seq})
    return event(socket, "snapshot")


def status(socket, expected):
    for _ in range(150):
        state = event(socket, "state")["state"]
        if state["status"] == expected:
            return state
        assert state["status"] not in {"finished", "error", "budget_exceeded"}, state
    pytest.fail(f"未到达状态 {expected}")


def test_two_clients_receive_same_delta(server):
    client, _ = server
    guest, headers, _ = guest_account(client)
    url = create_room(client, users=[guest["id"]])
    with client.websocket_connect(url) as first, client.websocket_connect(url, headers=headers) as second:
        snapshot(first)
        assert set(snapshot(second)["online"]) == {guest["id"], client.get("/api/auth/me").json()["id"]}
        first.send_json({"type": "start"})
        assert event(first, "message_delta") == event(second, "message_delta")


def test_interrupt_keeps_partial_text_and_pauses(server):
    client, _ = server
    with client.websocket_connect(create_room(client)) as socket:
        snapshot(socket)
        socket.send_json({"type": "start"})
        start = event(socket, "message_start")["message"]
        first = event(socket, "message_delta")
        socket.send_json({"type": "interrupt"})
        end = event(socket, "message_end", id=start["id"])
        assert end["interrupted"] and end["content"].startswith(first["delta"])
        assert status(socket, "paused")["speaker_id"] is None
        socket.send_json({"type": "resume"})
        assert event(socket, "message_start")["message"]["author_id"] == "ai_gemini"


def test_mentions_run_next_in_order(server):
    client, _ = server
    with client.websocket_connect(create_room(client)) as socket:
        snapshot(socket)
        socket.send_json({"type": "start"})
        assert event(socket, "message_start")["message"]["author_id"] == "ai_claude"
        socket.send_json({"type": "say", "content": "请先回答。", "mentions": ["ai_deepseek", "ai_gemini"],
                          "client_id": " tmp1 "})
        assert event(socket, "message")["client_id"] == " tmp1 "
        assert event(socket, "message_start")["message"]["author_id"] == "ai_deepseek"
        assert event(socket, "message_start")["message"]["author_id"] == "ai_gemini"


def test_interjection_appears_in_next_turn_last_user_message(server):
    client, fake = server
    with client.websocket_connect(create_room(client)) as socket:
        snapshot(socket)
        socket.send_json({"type": "start"})
        event(socket, "message_delta")
        socket.send_json({"type": "say", "content": "请先确定时间。", "mentions": [], "client_id": "tmp"})
        event(socket, "message", client_id="tmp")
        event(socket, "message_start")
        event(socket, "message_delta")
        prompt = fake.calls[1][1]
        assert prompt[-1]["role"] == "user" and "请先确定时间。" in prompt[-1]["content"]


def test_reconnect_replays_only_new_completed_messages(server):
    client, _ = server
    url = create_room(client)
    with client.websocket_connect(url) as socket:
        snapshot(socket)
        for text in ["第一条", "第二条"]:
            socket.send_json({"type": "say", "content": text, "mentions": [], "client_id": text})
        earlier = event(socket, "message")["message"]
        later = event(socket, "message")["message"]
    with client.websocket_connect(url) as socket:
        assert snapshot(socket, earlier["seq"])["messages"] == [later]


def test_reconnect_includes_current_partial_even_at_cursor(server):
    client, _ = server
    url = create_room(client)
    with client.websocket_connect(url) as first:
        snapshot(first)
        first.send_json({"type": "start"})
        prompt = event(first, "message_start")["message"]
        delta = event(first, "message_delta")["delta"]
        with client.websocket_connect(url) as second:
            [partial] = snapshot(second, prompt["seq"])["messages"]
            assert partial["id"] == prompt["id"] and partial["streaming"]
            assert partial["content"].startswith(delta)


def test_budget_stops_after_one_turn_and_records_usage(server):
    client, fake = server
    with client.websocket_connect(create_room(client, budget=0.0001)) as socket:
        snapshot(socket)
        socket.send_json({"type": "start"})
        event(socket, "message_end")
        assert event(socket, "message")["message"]["kind"] == "system"
        assert status(socket, "budget_exceeded")["cost_cny"] == float(fake.cost_cny)
    usage = client.get("/api/usage?range=all").json()
    assert usage["total_cny"] == float(Decimal("0.0123"))
    assert usage["tokens_in"] and usage["tokens_out"]


@pytest.mark.parametrize("failure_count", [1, 2])
def test_retry_recovers_or_emits_system_and_advances(server, failure_count):
    client, fake = server
    fake.failures = failure_count
    with client.websocket_connect(create_room(client)) as socket:
        snapshot(socket)
        socket.send_json({"type": "start"})
        for _ in range(2):
            assert event(socket, "message_start")["message"]["author_id"] == "ai_claude"
            result = event(socket, "message_end")
        if failure_count == 2:
            assert event(socket, "message")["message"]["content"] == "Claude 调用失败，已跳过"
        else:
            assert result["content"] and result["cost_cny"] > 0
        assert event(socket, "message_start")["message"]["author_id"] == "ai_gemini"


def test_invite_binding_and_admin_permissions(server):
    client, _ = server
    guest, headers, invite = guest_account(client)
    assert client.get("/api/invites").json()[0]["used_by"] == guest["id"]
    assert client.delete(f"/api/invites/{invite['code']}").json()["error"]["code"] == "invite_used"
    for path in ["/api/members", "/api/invites"]:
        response = client.post(path, json={}, headers=headers)
        assert response.status_code == 403 and response.json()["error"]["code"] == "forbidden"
    other = client.post("/api/auth/login", json={"invite_code": invite["code"], "name": "别人"})
    assert other.status_code == 400 and other.json()["error"]["code"] == "invite_used"


def test_pause_finishes_current_message_and_skip_does_not_pause(server):
    client, _ = server
    with client.websocket_connect(create_room(client)) as socket:
        snapshot(socket)
        socket.send_json({"type": "start"})
        first = event(socket, "message_start")["message"]
        socket.send_json({"type": "pause"})
        assert not event(socket, "message_end", id=first["id"])["interrupted"]
        assert status(socket, "paused")["speaker_id"] is None
        socket.send_json({"type": "resume"})
        second = event(socket, "message_start")["message"]
        socket.send_json({"type": "skip"})
        assert event(socket, "message_end", id=second["id"])["interrupted"]
        assert event(socket, "message_start")["message"]["author_id"] == "ai_deepseek"


def test_websocket_rejects_missing_session_and_room(server):
    client, _ = server
    with pytest.raises(WebSocketDisconnect) as missing_room, client.websocket_connect("/ws/rooms/r_missing") as socket:
        socket.receive_json()
    assert missing_room.value.code == 4404
    client.cookies.clear()
    with pytest.raises(WebSocketDisconnect) as missing_token, client.websocket_connect("/ws/rooms/r_missing") as socket:
        socket.receive_json()
    assert missing_token.value.code == 4401


def test_personal_budget_and_restart_keep_room_and_charges(tmp_path):
    settings = Settings(str(tmp_path / "roundtable.db"), "TABLE2", fake=True, monthly_user_limit=0.0001)
    with TestClient(create_app(settings, FakeLLM())) as client:
        login = client.post("/api/auth/login", json={"invite_code": "TABLE2", "name": "管理员"})
        token = login.cookies["rt_session"]
        assert login.json()["monthly_limit_cny"] == 0.0001
        url = create_room(client, auto_start=True)
        with client.websocket_connect(url) as socket:
            initial = snapshot(socket)
            if initial["state"]["status"] != "budget_exceeded":
                status(socket, "budget_exceeded")
    with TestClient(create_app(settings, FakeLLM())) as client:
        client.cookies.set("rt_session", token)
        with client.websocket_connect(url) as socket:
            saved = snapshot(socket)
            assert saved["state"]["status"] == "budget_exceeded"
            assert saved["messages"][0]["cost_cny"] == 0.0123
            assert "本月预算" in saved["messages"][-1]["content"]
        assert client.get("/api/usage?range=month").json()["total_cny"] == 0.0123
