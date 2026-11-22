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
