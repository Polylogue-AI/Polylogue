import asyncio
import json
from collections import Counter
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.llm import ChatStream, FakeLLM, LiteLLM, Usage
from app.main import create_app
from app.modes.base import Member, StructuredReply, Turn, build_prompt
from app.orchestrator import Output, stream_turn

from test_server import create_room, event, snapshot


class ScriptedLLM(FakeLLM):
    def __init__(self, reply=None, delay=0.02):
        super().__init__(delay=delay)
        self.calls = []
        self.reply = reply

    async def stream_chat(self, model, messages, temperature, max_tokens):
        self.calls.append((model, messages))
        answer = self.reply(model, messages) if self.reply else None
        if answer is None:
            return await super().stream_chat(model, messages, temperature, max_tokens)
        if not isinstance(answer, str):
            answer = json.dumps(answer, ensure_ascii=False)

        async def iterate(result):
            yield answer
            try:
                await asyncio.sleep(self.delay)
            finally:
                result.usage = Usage(1, 1, Decimal("0.0123"))

        return ChatStream(iterate)


def logged_in(fake):
    return TestClient(create_app(Settings(":memory:", "TABLE2", fake=True), fake))


def login(client):
    assert client.post("/api/auth/login", json={"invite_code": "TABLE2", "name": "管理员"}).is_success


def finish(socket):
    stream = {}
    events = []
    for _ in range(5000):
        item = socket.receive_json()
        events.append(item)
        if item["type"] == "message_start":
            stream[item["message"]["id"]] = []
        elif item["type"] == "message_delta":
            stream[item["id"]].append(item["delta"])
        elif item["type"] == "message_end":
            assert item["content"] == "".join(stream[item["id"]])
        elif item["type"] == "state" and item["state"]["status"] in {"finished", "error", "budget_exceeded"}:
            assert item["state"]["status"] == "finished", item
            return item["state"], events
    raise AssertionError("未收到结束状态")


def test_pipeline_executes_concurrently_and_caps_rework():
    def reply(_model, messages):
        request = messages[-1]["content"]
        if "输出任务列表" in request:
            return {"tasks": ["核对来源", "确定安排"]}
        if "完成这项任务" in request:
            return "补齐初稿及证据。"
        if "给出审查结论" in request:
            return {"verdict": "needs_fix" if "任务：核对来源" in request else "approved", "comment": "核对证据。"}
        return "保留通过的安排，来源待补。"

    fake = ScriptedLLM(reply, delay=0.08)
    with logged_in(fake) as client:
        login(client)
        url = create_room(client, mode="pipe", ai_member_ids=["ai_claude", "ai_gpt", "ai_gemini", "ai_deepseek"])
        with client.websocket_connect(url) as socket:
            snapshot(socket)
            socket.send_json({"type": "start"})
            state, frames = finish(socket)
        tasks = {task["title"]: task for task in state["mode_state"]["tasks"]}
        incomplete, complete = tasks["核对来源"], tasks["确定安排"]
        assert (incomplete["status"], incomplete["rework_count"]) == ("needs_fix", 1)
        assert (complete["stage"], complete["status"]) == ("merge", "done")
        assert tasks["汇总结果"]["status"] == "done"
        execution_ids = {incomplete["id"], complete["id"]}
        execution_starts = [(index, item["message"]["id"]) for index, item in enumerate(frames)
                            if item["type"] == "message_start" and item["message"]["meta"].get("task_id") in execution_ids]
        first_finished = next(index for index, item in enumerate(frames)
                              if item["type"] == "message_end" and item["id"] == execution_starts[0][1])
        assert execution_starts[1][0] < first_finished
        verdicts = [item["meta"]["verdict"] for item in frames
                    if item["type"] == "message_end" and "verdict" in item["meta"]]
        assert verdicts == ["needs_fix", "needs_fix", "approved"]


def test_crosscheck_anonymizes_peer_answers_and_persists_steer():
    def reply(model, messages):
        if "独立回答" in messages[-1]["content"]:
            return ("甲答案 " if model.startswith("anthropic/") else "乙答案 ") + model
        return None

    fake = ScriptedLLM(reply, delay=0.005)
    with logged_in(fake) as client:
        login(client)
        url = create_room(client, mode="cross", rounds=6)
        with client.websocket_connect(url) as socket:
            assert snapshot(socket)["state"]["total_rounds"] == 1
            socket.send_json({"type": "steer", "content": "每条建议都要写明依据。"})
            assert event(socket, "message")["message"]["kind"] == "steer"
            socket.send_json({"type": "start"})
            state, frames = finish(socket)
        assert state["mode_state"]["phase"] == "done"
        assert all("每条建议都要写明依据。" in prompt[0]["content"] for _, prompt in fake.calls)
        prompts = [prompt for _, prompt in fake.calls if "逐个点评" in prompt[-1]["content"]]
        reviews = [[entry["content"] for entry in prompt[1:-1] if entry["content"].startswith("[回答 ")] for prompt in prompts]
        assert reviews == [["[回答 B]：乙答案 [匿名]"], ["[回答 A]：甲答案 [匿名]"]]
        verdict = [item for item in frames if item["type"] == "message_end"][-1]
        assert verdict["meta"]["phase"] == "verdict"
        assert verdict["meta"]["agreements"] and verdict["meta"]["disagreements"]
        with client.websocket_connect(url) as socket:
            stored = snapshot(socket)["messages"]
        assert stored[0]["kind"] == "steer" and stored[-1]["kind"] == "verdict"


def test_debate_scores_every_round_and_ends_with_verdict():
    fake = ScriptedLLM(delay=0.001)
    with logged_in(fake) as client:
        login(client)
        url = create_room(client, mode="debate", rounds=2)
        with client.websocket_connect(url) as socket:
            assert snapshot(socket)["state"]["mode_state"]["score_pro"] is None
            socket.send_json({"type": "start"})
            state, frames = finish(socket)
        started = [item["message"] for item in frames if item["type"] == "message_start"]
        assert [(message["round"], message["meta"]["side"]) for message in started] == [
            (1, "pro"), (1, "con"), (1, "judge"), (2, "pro"), (2, "con"), (2, "judge"), (2, "judge"),
        ]
        assert state["mode_state"]["score_pro"] == 58
        assert started[-1]["kind"] == "verdict"


def test_context_compression_preserves_history_and_counts_usage():
    large_answer = "旧论点" * 5000

    def reply(_model, messages):
        if messages[0]["content"].startswith("压缩早期讨论"):
            assert large_answer in messages[-1]["content"]
            return "这是第一轮的摘要。"
        if '第 1 轮' in messages[-1]["content"] and not any(large_answer in item["content"] for item in messages):
            return large_answer
        return "按建议继续推进。"

    class CompressionLLM(ScriptedLLM):
        def cheapest(self, members, _messages):
            return next(member for member in members if member.id == "ai_gemini")

    fake = CompressionLLM(reply, delay=0)
    with logged_in(fake) as client:
        login(client)
        url = create_room(client, rounds=2, ai_member_ids=["ai_claude", "ai_gemini"])
        with client.websocket_connect(url) as socket:
            snapshot(socket)
            socket.send_json({"type": "start"})
            state, _ = finish(socket)
        assert state["summarized_until_round"] == 1
        calls = [(model, prompt) for model, prompt in fake.calls if prompt[0]["content"].startswith("压缩早期讨论")]
        assert len(calls) == 1 and calls[0][0].startswith("gemini/")
        next_prompt = fake.calls[3][1]
        assert any("[早期讨论摘要]：这是第一轮的摘要。" == item["content"] for item in next_prompt)
        assert all(large_answer not in item["content"] for item in next_prompt)
        assert client.get("/api/usage?range=all").json()["total_cny"] == 0.0738
        with client.websocket_connect(url) as socket:
            assert snapshot(socket)["messages"][0]["content"] == large_answer


def test_parallel_snapshot_and_interrupt_keep_both_partials():
    fake = ScriptedLLM(lambda _model, _messages: "首段内容", delay=1)
    with logged_in(fake) as client:
        login(client)
        url = create_room(client, mode="cross", auto_start=True)
        with client.websocket_connect(url) as first:
            initial = snapshot(first)
            started = {item["id"] for item in initial["messages"] if item["streaming"]}
            while len(started) < 2:
                started.add(event(first, "message_start")["message"]["id"])
            with client.websocket_connect(url) as second:
                snap = snapshot(second)
                assert {item["id"] for item in snap["messages"] if item["streaming"]} == started
                second.send_json({"type": "interrupt"})
                ended = [event(second, "message_end") for _ in range(2)]
                assert {item["id"] for item in ended} == started
                assert all(item["interrupted"] and item["content"] == "首段内容" for item in ended)


def test_stream_failure_keeps_only_visible_partial_and_retries():
    class BreakingLLM(ScriptedLLM):
        async def stream_chat(self, model, messages, temperature, max_tokens):
            if not self.calls:
                self.calls.append((model, messages))

                async def iterate(result):
                    yield "已输出的一段"
                    result.usage = Usage(1, 1, Decimal("0.0123"))
                    raise RuntimeError("流中故障")

                return ChatStream(iterate)
            return await super().stream_chat(model, messages, temperature, max_tokens)

    with logged_in(BreakingLLM(delay=0.001)) as client:
        login(client)
        url = create_room(client)
        with client.websocket_connect(url) as socket:
            snapshot(socket)
            socket.send_json({"type": "start"})
            _, frames = finish(socket)
        starts = [item["message"] for item in frames if item["type"] == "message_start"]
        assert starts[0]["author_id"] == starts[1]["author_id"] == "ai_claude"
        first_end = next(item for item in frames if item["type"] == "message_end")
        assert first_end["content"] == "已输出的一段" and first_end["interrupted"]


class InterruptibleLLM(ScriptedLLM):
    def __init__(self, stage, blocked_providers):
        super().__init__(delay=0.001)
        self.stage = stage
        self.blocked_providers = blocked_providers
        self.attempts = Counter()

    async def stream_chat(self, model, messages, temperature, max_tokens):
        if self.stage not in messages[-1]["content"]:
            return await super().stream_chat(model, messages, temperature, max_tokens)
        provider = model.split("/", 1)[0]
        self.attempts[provider] += 1
        blocked = provider in self.blocked_providers and self.attempts[provider] == 1

        async def iterate(result):
            try:
                yield "未完成的旧稿" if blocked else "已完成的完整稿件"
                if blocked:
                    await asyncio.Event().wait()
            finally:
                result.usage = Usage(1, 1, Decimal("0.0123"))

        return ChatStream(iterate)


def interrupt_after_some_finish(socket, partial_count):
    complete = set()
    partial = set()
    while not complete or len(partial) < partial_count:
        item = socket.receive_json()
        if item["type"] == "message_end" and item["content"] == "已完成的完整稿件":
            complete.add(item["id"])
        if item["type"] == "message_delta" and item["delta"] == "未完成的旧稿":
            partial.add(item["id"])
    socket.send_json({"type": "interrupt"})
    while True:
        update = event(socket, "state")["state"]
        if update["status"] == "paused":
            return complete, partial, update["mode_state"]


def read_history(client, url):
    with client.websocket_connect(url) as socket:
        return snapshot(socket)["messages"]


def test_crosscheck_resume_restarts_only_interrupted_answers():
    fake = InterruptibleLLM("独立回答", {"openai", "gemini"})
    with logged_in(fake) as client:
        login(client)
        url = create_room(client, mode="cross", ai_member_ids=["ai_claude", "ai_gpt", "ai_gemini", "ai_deepseek"])
        with client.websocket_connect(url) as socket:
            snapshot(socket)
            socket.send_json({"type": "start"})
            complete, partial, paused_mode = interrupt_after_some_finish(socket, 2)
            assert paused_mode["phase"] == "answer"
            assert fake.attempts == {"anthropic": 1, "openai": 1, "gemini": 1}
            socket.send_json({"type": "resume"})
            state, _ = finish(socket)
        messages = read_history(client, url)

    assert fake.attempts == {"anthropic": 1, "openai": 2, "gemini": 2}
    assert state["mode_state"]["phase"] == "done"
    answers = [message for message in messages if message["meta"].get("phase") == "answer"]
    assert {message["id"] for message in answers if message["interrupted"]} == partial
    finished = [message for message in answers if not message["interrupted"]]
    assert {message["author_id"] for message in finished} == {"ai_claude", "ai_gpt", "ai_gemini"}
    assert len(finished) == 3 and all(message["content"] == "已完成的完整稿件" for message in finished)
    assert complete < {message["id"] for message in finished}
    partial_seq = {message["author_id"]: message["seq"] for message in answers if message["interrupted"]}
    assert all(message["seq"] > partial_seq.get(message["author_id"], 0) for message in finished)
    assert len([message for message in messages if message["meta"].get("phase") == "review"]) == 3
    assert messages[-1]["meta"]["agreements"] and messages[-1]["meta"]["disagreements"]


def test_pipeline_resume_preserves_finished_draft_and_reviews_all_tasks():
    fake = InterruptibleLLM("完成这项任务", {"gemini"})
    with logged_in(fake) as client:
        login(client)
        url = create_room(client, mode="pipe", ai_member_ids=["ai_claude", "ai_gpt", "ai_gemini", "ai_deepseek"])
        with client.websocket_connect(url) as socket:
            snapshot(socket)
            socket.send_json({"type": "start"})
            complete, partial, paused_mode = interrupt_after_some_finish(socket, 1)
            assert {task["status"] for task in paused_mode["tasks"] if task["stage"] in {"exec", "review"}} == {"queued", "running"}
            assert fake.attempts == {"openai": 1, "gemini": 1}
            socket.send_json({"type": "resume"})
            state, _ = finish(socket)
        messages = read_history(client, url)

    assert fake.attempts == {"openai": 1, "gemini": 2}
    drafts = [message for message in messages if message["content"] == "已完成的完整稿件"]
    assert len(drafts) == 2 and complete < {message["id"] for message in drafts}
    assert {message["id"] for message in messages if message["interrupted"]} == partial
    old = next(message for message in messages if message["id"] in partial)
    new = next(message for message in drafts if message["meta"] == old["meta"])
    assert new["seq"] > old["seq"] and new["id"] != old["id"]
    assert {message["meta"]["task_id"] for message in messages if message["meta"].get("verdict") == "approved"} == {
        message["meta"]["task_id"] for message in drafts
    }
    assert all(task["status"] == "done" for task in state["mode_state"]["tasks"])
    assert messages[-1]["kind"] == "summary"


@pytest.mark.asyncio
async def test_structured_turn_uses_json_only_instructions_and_larger_budget():
    class CaptureLLM(FakeLLM):
        async def stream_chat(self, model, messages, temperature, max_tokens):
            self.max_tokens = max_tokens
            return await super().stream_chat(model, messages, temperature, max_tokens)

    member = Member("ai_test", "测试者", "fake/model", "评审", "按任务要求答复", max_chars=100)
    turn = Turn(member, 1, goal='仅返回 JSON {"comment":"意见"}。', parse=StructuredReply)
    prompt = build_prompt(turn, "写点评", [])
    assert prompt[-1]["role"] == "user" and "仅返回 JSON" in prompt[-1]["content"]
    assert "至少指出" not in prompt[-1]["content"] and "发言不超过" not in prompt[-1]["content"]
    fake = CaptureLLM({member.model: '{"comment":"合格"}'})
    await stream_turn(fake, turn, prompt, Output())
    assert fake.max_tokens >= 1200


def test_catalog_includes_unassigned_models_with_model_labels():
    with logged_in(FakeLLM()) as client:
        login(client)
        models = {model["id"]: model for model in client.get("/api/models").json()}
        assigned = {member["model"] for member in client.get("/api/members").json()}
    for model_id, label in [("anthropic/claude-sonnet-5-5", "Claude Sonnet 5.5"),
                            ("gemini/gemini-3.8-flash", "Gemini 3.8 Flash"),
                            ("dashscope/qwen-plus", "Qwen Plus")]:
        assert model_id not in assigned
        assert models[model_id]["label"] == label and models[model_id]["available"]


def test_real_catalog_reports_provider_check_and_requires_configured_key(monkeypatch):
    monkeypatch.setenv("LITELLM_OFFLINE_MODE", "true")
    monkeypatch.setenv("LITELLM_LOCAL_MODEL_COST_MAP", "True")
    import litellm

    engine = LiteLLM(Decimal("7.2"))
    engine.record_check("anthropic/claude-haiku-5-5", True)
    engine.record_check("gemini/gemini-3.5-flash-lite", True)
    engine.record_check("gemini/gemini-3.8-flash", False)
    engine.record_check("openai/gpt-5", True)
    monkeypatch.setattr(litellm, "validate_environment", lambda model: {
        "keys_in_environment": not model.startswith("openai/"),
    })
    with TestClient(create_app(Settings(":memory:", "TABLE2"), engine)) as client:
        login(client)
        options = {item["id"]: item["available"] for item in client.get("/api/models").json()}
    assert options["anthropic/claude-sonnet-5-5"]
    assert not options["gemini/gemini-3.5-flash-lite"] and not options["openai/gpt-5-mini"]
