import asyncio
import json
import threading
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.llm import FakeLLM
from app.main import create_app
from app.sandbox import FakeSandbox, file_error
from app.schemas import RunInput

from test_modes import login
from test_server import create_room, event, guest_account, snapshot, status


MODEL = "anthropic/claude-haiku-5-5"
REQUEST = {"language": "python", "files": [{"path": "main.py", "content": "print(7)"}]}


def tool(arguments=None, *, call_id="call_test"):
    return {"id": call_id, "type": "function", "function": {
        "name": "run_code", "arguments": json.dumps(REQUEST) if arguments is None else arguments,
    }}


def options(**changes):
    return replace(Settings(":memory:", "TABLE2", fake=True, sandbox_enabled=True), **changes)


def enable(client, *members):
    for member in members:
        response = client.patch(f"/api/members/{member}", json={"can_run_code": True})
        assert response.is_success and response.json()["can_run_code"]


def frames_for(frames, author):
    return [frame["message"] for frame in frames
            if frame["type"] == "message_start" and frame["message"]["author_id"] == author]


def test_text_run_text_order_cost_budget_and_context():
    seen = []

    def script(model, messages, tools):
        seen.append((model, list(messages), tools))
        if tools and messages[-1]["role"] != "tool":
            assert "不能安装依赖" in messages[0]["content"]
            return "  开始验证", [tool()]
        if messages[-1]["role"] == "tool":
            assert json.loads(messages[-1]["content"])["status"] == "ok"
            return "验证结束", []
        return None

    with TestClient(create_app(options(), FakeLLM(tool_script=script))) as client:
        login(client)
        enable(client, "ai_claude")
        assert client.get("/api/sandbox").json()["available"]
        with client.websocket_connect(create_room(client)) as socket:
            snapshot(socket)
            socket.send_json({"type": "start"})
            state, frames = finish_with_runs(socket)
    messages = frames_for(frames, "ai_claude")
    assert [message["kind"] for message in messages] == ["chat", "run", "chat"]
    assert [message["seq"] for message in messages] == [1, 2, 3]
    ends = {frame["id"]: frame for frame in frames if frame["type"] == "message_end"}
    assert [ends[message["id"]]["cost_cny"] for message in messages] == [0.0123, None, 0.0123]
    assert state["cost_cny"] == pytest.approx(sum(frame["cost_cny"] or 0 for frame in ends.values()))
    assert state["cost_cny"] == 0.0615
    after = next(messages for model, messages, _ in seen if model != MODEL)
    assert any("[Claude 运行了代码]" in item["content"] for item in after)
    assert all(item["role"] != "tool" and "tool_calls" not in item for item in after)


def finish_with_runs(socket, expected="finished"):
    frames = []
    started = {}
    for _ in range(5000):
        frame = socket.receive_json()
        frames.append(frame)
        if frame["type"] == "message_start":
            message = frame["message"]
            started[message["id"]] = (message["kind"], [])
        elif frame["type"] == "message_delta":
            kind, deltas = started[frame["id"]]
            assert kind != "run"
            deltas.append(frame["delta"])
        elif frame["type"] == "message_end" and frame["id"] in started:
            kind, deltas = started[frame["id"]]
            if kind != "run":
                assert frame["content"] == "".join(deltas)
        elif frame["type"] == "state" and frame["state"]["status"] in {"finished", "budget_exceeded", "error"}:
            assert frame["state"]["status"] == expected, frame
            return frame["state"], frames
    pytest.fail("未达结束状态")


@pytest.mark.parametrize("budget", [1, 0.01])
def test_tool_only_books_one_charge_and_respects_budget_limit(budget):
    claude_calls = []

    def script(model, messages, tools):
        if model != MODEL:
            return None
        claude_calls.append((list(messages), tools))
        if tools:
            return "   ", [tool(), tool(call_id="excess")]
        return "根据已有结果，答案为 7。", []

    with TestClient(create_app(options(sandbox_max_runs_per_turn=1), FakeLLM(tool_script=script))) as client:
        login(client)
        enable(client, "ai_claude")
        with client.websocket_connect(create_room(client, budget=budget)) as socket:
            snapshot(socket)
            socket.send_json({"type": "start"})
            final, frames = finish_with_runs(socket, "finished" if budget == 1 else "budget_exceeded")
    messages = frames_for(frames, "ai_claude")
    assert [item["kind"] for item in messages] == (["run", "chat"] if budget == 1 else ["run"])
    start = messages[0]
    end = next(frame for frame in frames if frame["type"] == "message_end" and frame["id"] == start["id"])
    assert end["cost_cny"] == 0.0123 and end["meta"]["run"]["status"] == "ok"
    if budget == 1:
        prompt, tools = claude_calls[1]
        assert len(claude_calls) == 2 and tools is None and "运行次数已用完" in prompt[-1]["content"]
        assert json.loads(prompt[-2]["content"])["status"] == "error"
    else:
        assert len(claude_calls) == 1 and final["cost_cny"] == 0.0123


class BlockingSandbox(FakeSandbox):
    def __init__(self, settings):
        super().__init__(settings)
        self.cancelled = 0
        self.started = threading.Event()
        self.released = threading.Event()
        self.calls = 0

    async def execute(self, request):
        self.calls += 1
        if self.calls == 1:
            self.started.set()
            try:
                while not self.released.is_set():
                    await asyncio.sleep(0.005)
            except asyncio.CancelledError:
                self.cancelled += 1
                raise
        return await super().execute(request)


@pytest.mark.parametrize("action", ["interrupt", "skip", "pause"])
def test_parallel_run_controls(action):
    settings = options()
    sandbox = BlockingSandbox(settings)
    def script(model, messages, tools):
        if tools and not any(item["role"] == "tool" for item in messages):
            return "", [tool()]
        if messages[-1]["role"] == "tool":
            return "验收完成。", []
        return None

    with TestClient(create_app(settings, FakeLLM(tool_script=script), sandbox)) as client:
        login(client)
        enable(client, "ai_claude")
        url = create_room(client, mode="cross", ai_member_ids=["ai_deepseek", "ai_claude", "ai_gemini"],
                          duties={"ai_deepseek": "judge", "ai_claude": "answerer", "ai_gemini": "answerer"})
        with client.websocket_connect(url) as socket:
            snapshot(socket)
            socket.send_json({"type": "start"})
            first = event(socket, "message_start")["message"]
            assert first["kind"] == "run" and sandbox.started.wait(2)
            socket.send_json({"type": action})
            if action == "pause":
                sandbox.released.set()
            ended = event(socket, "message_end", id=first["id"])
            assert ended["interrupted"] is (action != "pause")
            assert ended["meta"]["run"]["status"] == ("ok" if action == "pause" else "cancelled")
            if action != "skip":
                status(socket, "paused")
                socket.send_json({"type": "resume"})
            _, frames = finish_with_runs_after_existing(socket)
            if action == "interrupt":
                restarted = next(item for item in frames_for(frames, "ai_claude") if item["kind"] == "run")
                assert restarted["id"] != first["id"] and restarted["seq"] > first["seq"]
    assert sandbox.cancelled == (0 if action == "pause" else 1)
    assert sandbox.calls == (2 if action == "interrupt" else 1)


def finish_with_runs_after_existing(socket):
    frames = []
    for _ in range(5000):
        frame = socket.receive_json()
        frames.append(frame)
        if frame["type"] == "state" and frame["state"]["status"] in {"finished", "error", "budget_exceeded"}:
            assert frame["state"]["status"] == "finished", frame
            return frame["state"], frames
    pytest.fail("未达结束状态")


def test_pipeline_reviewer_sees_only_own_task_runs():
    reviews = []

    def script(model, messages, tools):
        request = messages[-1]["content"]
        if tools and messages[-1]["role"] != "tool":
            name = "task1" if "梳理目标" in request else "task2"
            args = json.dumps({"language": "python", "files": [{"path": name + ".py", "content": "print(1)"}]})
            return f"{name} 初稿", [tool(args)]
        if messages[-1]["role"] == "tool":
            return "执行完成", []
        if "给出审查结论" in request:
            assert tools is None
            reviews.append((request, "\n".join(item["content"] for item in messages)))
        elif "输出任务列表" in request or "合并通过审查" in request:
            assert tools is None
        return None

    with TestClient(create_app(options(), FakeLLM(tool_script=script))) as client:
        login(client)
        enable(client, "ai_claude", "ai_gemini", "ai_deepseek")
        with client.websocket_connect(create_room(client, mode="pipe")) as socket:
            snapshot(socket)
            socket.send_json({"type": "start"})
            finish_with_runs(socket)
    assert len(reviews) == 2
    for request, prompt in reviews:
        ours, other = ("task1", "task2") if "梳理目标" in request else ("task2", "task1")
        assert f"运行 python {ours}.py" in prompt and other + ".py" not in prompt
        assert f"{ours} 初稿" in prompt and "执行完成" in prompt


class LostSandbox(FakeSandbox):
    async def run(self, request, on_start):
        self.reason = "Docker 已停止"
        return await super().run(request, on_start)


@pytest.mark.parametrize("case", ["unavailable", "bad_json", "bad_path"])
def test_tool_error_is_returned_and_turn_continues(case):
    observed = []
    settings = options()
    sandbox = LostSandbox(settings) if case == "unavailable" else FakeSandbox(settings)
    arguments = {"unavailable": None, "bad_json": "{bad", "bad_path":
                 json.dumps(REQUEST | {"files": [{"path": "../main.py", "content": "pass"}]})}[case]

    def script(model, messages, tools):
        if model != MODEL:
            return None
        if last := next((item for item in reversed(messages) if item["role"] == "tool"), None):
            observed.append(json.loads(last["content"]))
            return "继续发言", []
        if tools:
            return "", [tool(arguments)]
        return None

    with TestClient(create_app(settings, FakeLLM(tool_script=script), sandbox)) as client:
        login(client)
        enable(client, "ai_claude")
        with client.websocket_connect(create_room(client)) as socket:
            snapshot(socket)
            socket.send_json({"type": "start"})
            finish_with_runs(socket)
    assert observed[0]["status"] == ("unavailable" if case == "unavailable" else "error")


def test_human_run_busy_and_disabled():
    settings = options()
    sandbox = BlockingSandbox(settings)
    with TestClient(create_app(settings, sandbox=sandbox)) as client:
        login(client)
        with client.websocket_connect(create_room(client)) as socket:
            snapshot(socket)
            request = REQUEST | {"type": "run", "reply_to": "m_origin"}
            socket.send_json(request)
            started = event(socket, "message_start")["message"]
            assert started["kind"] == "run" and started["reply_to"] == "m_origin" and sandbox.started.wait(2)
            socket.send_json(request)
            assert event(socket, "error")["code"] == "run_busy"
            sandbox.released.set()
            ended = event(socket, "message_end")
            assert ended["meta"]["run"]["status"] == "ok" and ended["cost_cny"] is None
    with TestClient(create_app(options(sandbox_enabled=False))) as client:
        login(client)
        with client.websocket_connect(create_room(client)) as socket:
            assert snapshot(socket)["state"]["speaker_id"] is None
            socket.send_json(REQUEST | {"type": "run"})
            assert event(socket, "error")["code"] == "sandbox_disabled"


@pytest.mark.parametrize("files", [
    [{"path": path, "content": ""}] for path in ("/main.py", "../main.py", "a/../b", "C:/x", "dir\\x")
] + [
    [{"path": f"file_{i}", "content": ""} for i in range(21)],
    [{"path": "main.py", "content": "字" * 70_000}],
])
def test_invalid_files_never_execute(files):
    request = RunInput.model_validate(REQUEST | {"files": files})
    assert file_error(request)


@pytest.mark.parametrize("capable,permitted,mode", [
    (True, False, "round"),
    (False, True, "round"),
    (True, True, "debate"),
])
def test_disallowed_model_member_or_stage_has_no_tools(capable, permitted, mode):
    tools_seen = []

    class Engine(FakeLLM):
        @staticmethod
        def supports_tools(model):
            return capable

    def script(model, messages, tools):
        tools_seen.append(tools)
        return None

    with TestClient(create_app(options(), Engine(tool_script=script))) as client:
        login(client)
        if permitted:
            enable(client, "ai_claude", "ai_gemini", "ai_deepseek")
        with client.websocket_connect(create_room(client, mode=mode)) as socket:
            snapshot(socket)
            socket.send_json({"type": "start"})
            finish_with_runs(socket)
    assert tools_seen and all(item is None for item in tools_seen)


def test_human_runs_use_shared_queue_and_block_repeats():
    settings = options(sandbox_max_parallel=1)
    sandbox = BlockingSandbox(settings)
    with TestClient(create_app(settings, sandbox=sandbox)) as client:
        login(client)
        guest, headers, _ = guest_account(client)
        url = create_room(client, users=[guest["id"]])
        with client.websocket_connect(url) as first, client.websocket_connect(url, headers=headers) as second:
            snapshot(first)
            snapshot(second)
            first.send_json(REQUEST | {"type": "run"})
            started = event(second, "message_start")["message"]
            assert started["meta"]["run"]["status"] == "running" and sandbox.started.wait(2)
            second.send_json(REQUEST | {"type": "run"})
            queued = event(second, "message_start")["message"]
            assert queued["author_id"] == guest["id"] and queued["meta"]["run"]["status"] == "queued"
            assert sandbox.calls == 1
            second.send_json(REQUEST | {"type": "run"})
            assert event(second, "error")["code"] == "run_busy"
            sandbox.released.set()
            assert event(second, "message_end", id=started["id"])["meta"]["run"]["status"] == "ok"
            assert event(second, "message_end", id=queued["id"])["meta"]["run"]["status"] == "ok"
    assert sandbox.calls == 2


def test_legacy_member_defaults_and_tool_override():
    class UnknownModel(FakeLLM):
        @staticmethod
        def supports_tools(model):
            return False

    settings = options(tool_models=frozenset({MODEL}))
    app = create_app(settings, UnknownModel())
    with TestClient(app) as client:
        login(client)
        def remove_field():
            db = app.state.db
            member = db.get("members", "ai_claude")
            del member["can_run_code"]
            with db.transaction():
                db.put("members", "ai_claude", member)

        client.portal.call(remove_field)
        members = {member["id"]: member for member in client.get("/api/members").json()}
        catalog = {option["id"]: option for option in client.get("/api/models").json()}
        assert members["ai_claude"]["can_run_code"] is False
        assert catalog[MODEL]["supports_tools"] is True
        assert catalog["openai/gpt-5"]["supports_tools"] is False


def test_blank_test_counts_as_omitted_for_python():
    request = RunInput.model_validate(REQUEST | {"test": "  "})
    assert request.test is None and file_error(request) is None
    request = RunInput.model_validate(REQUEST | {"test": "console.log(7)"})
    assert file_error(request) == "仅 HTML 支持 test"


@pytest.mark.parametrize("trigger", ["status", "run"])
def test_unavailable_sandbox_redetects_once_after_cooldown(monkeypatch, trigger):
    import app.sandbox as sandbox_module

    now = [100.0]
    checks = []
    ready = [False]

    class RecoveringSandbox(FakeSandbox):
        async def detect(self):
            checks.append(now[0])
            await asyncio.sleep(0.02)
            self.reason = None if ready[0] else "Docker 未启动"

    monkeypatch.setattr(sandbox_module, "monotonic", lambda: now[0])
    settings = options()
    sandbox = RecoveringSandbox(settings)
    with TestClient(create_app(settings, sandbox=sandbox)) as client:
        login(client)
        assert not client.get("/api/sandbox").json()["available"]
        ready[0] = True
        now[0] += 29
        assert not client.get("/api/sandbox").json()["available"]
        assert checks == [100]
        now[0] += 2
        if trigger == "status":
            from concurrent.futures import ThreadPoolExecutor

            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: client.get("/api/sandbox").json(), range(4)))
            assert all(item["available"] for item in results)
        else:
            with client.websocket_connect(create_room(client)) as socket:
                snapshot(socket)
                socket.send_json(REQUEST | {"type": "run"})
                assert event(socket, "message_end")["meta"]["run"]["status"] == "ok"
        assert checks == [100, 131]
