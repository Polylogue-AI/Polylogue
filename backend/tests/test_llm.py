import asyncio
from decimal import Decimal

import pytest

from app.llm import LiteLLM, Usage


@pytest.mark.asyncio
async def test_litellm_stream_usage_and_exchange_rate(monkeypatch):
    monkeypatch.setenv("LITELLM_OFFLINE_MODE", "true")
    monkeypatch.setenv("LITELLM_LOCAL_MODEL_COST_MAP", "True")
    import litellm

    model = "anthropic/claude-haiku-4-5-20251001"
    messages = [{"role": "user", "content": "如何分工？"}]

    async def mock_completion(**kwargs):
        assert kwargs == {
            "model": model, "messages": messages, "temperature": 0.5,
            "max_tokens": 450, "stream": True, "stream_options": {"include_usage": True},
            "drop_params": True,
        }

        async def chunks():
            for text in ("你", "好"):
                yield litellm.ModelResponseStream(
                    id="test", model=model,
                    choices=[{"index": 0, "delta": {"content": text},
                              "finish_reason": "length" if text == "好" else None}],
                )
            yield litellm.ModelResponseStream(
                id="test", model=model, choices=[],
                usage={"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
            )

        return chunks()

    monkeypatch.setattr(litellm, "acompletion", mock_completion)
    stream = await LiteLLM(Decimal("7.2")).stream_chat(model, messages, 0.5, 450)

    assert [part async for part in stream] == ["你", "好"]
    assert stream.truncated
    assert stream.usage == Usage(100, 20, Decimal("0.0014"))


@pytest.mark.asyncio
async def test_usage_error_does_not_mask_stream_cancellation(monkeypatch):
    monkeypatch.setenv("LITELLM_OFFLINE_MODE", "true")
    monkeypatch.setenv("LITELLM_LOCAL_MODEL_COST_MAP", "True")
    import litellm

    async def mock_completion(**kwargs):
        async def chunks():
            yield litellm.ModelResponseStream(
                choices=[{"index": 0, "delta": {"content": "你"}}],
            )
            raise asyncio.CancelledError

        return chunks()

    def broken_usage(*args, **kwargs):
        raise ValueError("malformed usage")

    monkeypatch.setattr(litellm, "acompletion", mock_completion)
    monkeypatch.setattr(litellm, "stream_chunk_builder", broken_usage)
    stream = await LiteLLM(Decimal("7.2")).stream_chat(
        "anthropic/claude-haiku-4-5-20251001", [{"role": "user", "content": "问题"}], 0.5, 450,
    )

    assert await anext(stream) == "你"
    with pytest.raises(asyncio.CancelledError):
        await anext(stream)
    assert stream.usage == Usage(2, 1, None)



@pytest.mark.asyncio
@pytest.mark.parametrize("model", [
    "anthropic/claude-haiku-5-5",
    "anthropic/claude-opus-5-5-20261101",
    "openai/gpt-5.1-mini",
    "openai/o3-mini",
])
async def test_litellm_omits_temperature_for_unsupported_models(monkeypatch, model):
    monkeypatch.setenv("LITELLM_OFFLINE_MODE", "true")
    monkeypatch.setenv("LITELLM_LOCAL_MODEL_COST_MAP", "True")
    import litellm

    async def mock_completion(**kwargs):
        assert kwargs["model"] == model
        assert "temperature" not in kwargs
        assert kwargs["drop_params"] is True

        async def chunks():
            yield litellm.ModelResponseStream(
                choices=[{"index": 0, "delta": {"content": "OK"}}],
            )

        return chunks()

    monkeypatch.setattr(litellm, "acompletion", mock_completion)
    stream = await LiteLLM(Decimal("7.2")).stream_chat(
        model, [{"role": "user", "content": "test"}], 0.65, 450,
    )
    assert [part async for part in stream] == ["OK"]


@pytest.mark.asyncio
async def test_litellm_reassembles_interleaved_tool_fragments(monkeypatch):
    import litellm

    from app.sandbox import TOOL

    model = "anthropic/claude-haiku-5-5"
    messages = [{"role": "user", "content": "运行验证"}]

    async def completion(**kwargs):
        assert kwargs["tools"] == [TOOL]

        async def chunks():
            blocks = [
                [{"index": 0, "id": "alpha", "function": {"name": "run_code", "arguments": '{"language":'}}],
                [{"index": 1, "id": "beta", "function": {"name": "run_code", "arguments": '{"files":'}}],
                [{"index": 0, "function": {"arguments": '"python"}'}},
                 {"index": 1, "function": {"arguments": '[]}'}}],
            ]
            for calls in blocks:
                yield litellm.ModelResponseStream(
                    id="test", model=model, choices=[{"index": 0, "delta": {"tool_calls": calls}}],
                )
            yield litellm.ModelResponseStream(
                id="test", model=model, choices=[],
                usage={"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
            )
        return chunks()

    monkeypatch.setattr(litellm, "acompletion", completion)
    engine = LiteLLM(Decimal("7.2"))
    stream = await engine.stream_chat(model, messages, 0.5, 100, tools=[TOOL])
    assert [part async for part in stream] == []
    assert [item["id"] for item in stream.tool_calls] == ["alpha", "beta"]
    assert [item["function"]["arguments"] for item in stream.tool_calls] == ['{"language":"python"}', '{"files":[]}']
    assert engine.provider_checks["anthropic"] is True
    assert stream.usage and stream.usage.tokens_out == 20


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_only", [False, True])
async def test_missing_wire_usage_estimates_cost_even_for_tool_only_response(monkeypatch, caplog, tool_only):
    import litellm

    from app.modes.base import Member, Turn
    from app.orchestrator import Output, stream_turn
    from app.sandbox import TOOL

    model = "anthropic/claude-haiku-4-5-20251001"
    engine = LiteLLM(Decimal("7.2"))
    seen = []

    def token_counter(**kwargs):
        seen.append(kwargs)
        return 100 if "messages" in kwargs else 20

    async def completion(**_):
        async def chunks():
            if tool_only:
                delta = {"tool_calls": [{
                    "index": 0, "id": "call_a",
                    "function": {"name": "run_code", "arguments": "{}"},
                }]}
            else:
                delta = {"content": "正文"}
            yield litellm.ModelResponseStream(id="test", model=model, choices=[{"index": 0, "delta": delta}])
        return chunks()

    monkeypatch.setattr(litellm, "acompletion", completion)
    monkeypatch.setattr(litellm, "token_counter", token_counter)
    output = Output()
    turn = Turn(Member("ai_test", "测试", model, "测试", ""), 1)
    await stream_turn(engine, turn, [{"role": "user", "content": "试跑"}], output,
                      tools=[TOOL] if tool_only else None)
    assert output.usage == Usage(100, 20, Decimal("0.0014"))
    assert "缺少用量数据" in caplog.text and len(seen) == 2
    if tool_only:
        assert "run_code" in seen[1]["text"] and not output.content
        assert output.tool_calls[0]["id"] == "call_a"
    else:
        assert output.content == "正文"
