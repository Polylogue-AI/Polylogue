"""Streaming chat with per-call usage, independent of the discussion mode."""

import asyncio
import re
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Protocol, TypedDict


class ChatMessage(TypedDict):
    role: str
    content: str


@dataclass(frozen=True)
class Usage:
    tokens_in: int
    tokens_out: int
    cost_cny: Decimal | None


class ChatStream(AsyncIterator[str]):
    """An async iterator whose own usage is available after it closes."""

    def __init__(self, iterate: Callable[["ChatStream"], AsyncGenerator[str, None]]) -> None:
        self.usage: Usage | None = None
        self._iterator = iterate(self)

    async def __anext__(self) -> str:
        return await anext(self._iterator)

    async def aclose(self) -> None:
        await self._iterator.aclose()


class LLM(Protocol):
    async def stream_chat(
        self, model: str, messages: list[ChatMessage], temperature: float,
        max_tokens: int | None,
    ) -> ChatStream: ...


class LiteLLM:
    def __init__(self, usd_cny_rate: Decimal) -> None:
        if not usd_cny_rate.is_finite() or usd_cny_rate <= 0:
            raise ValueError("USD_CNY_RATE 必须是大于零的数字")
        self.usd_cny_rate = usd_cny_rate
        self.checks: dict[str, bool] = {}

    async def stream_chat(
        self, model: str, messages: list[ChatMessage], temperature: float,
        max_tokens: int | None,
    ) -> ChatStream:
        import litellm

        async def iterate(result: ChatStream) -> AsyncGenerator[str, None]:
            options = {"max_tokens": max_tokens} if max_tokens is not None else {}
            if model == "deepseek/deepseek-flash":
                # Reserve the short turn budget for text that the roundtable can use.
                options["thinking"] = {"type": "disabled"}
            chunks = []
            parts: list[str] = []
            try:
                response = await litellm.acompletion(
                    model=model, messages=messages, temperature=temperature,
                    stream=True, stream_options={"include_usage": True}, drop_params=True, **options,
                )
            except Exception:
                self.checks[model] = False
                raise
            try:
                async for chunk in response:
                    chunks.append(chunk)
                    if chunk.choices and (delta := chunk.choices[0].delta.content):
                        parts.append(delta)
                        yield delta
                self.checks[model] = bool("".join(parts).strip())
            except Exception:
                self.checks[model] = False
                raise
            finally:
                try:
                    await response.aclose()
                finally:
                    if chunks:
                        output = "".join(parts)
                        tokens_in = sum(len(message["content"]) for message in messages)
                        tokens_out = len(output)
                        cost = None
                        try:
                            complete = litellm.stream_chunk_builder(chunks, messages=messages)
                            usage = getattr(complete, "usage", None)
                            prompt_tokens = getattr(usage, "prompt_tokens", None)
                            completion_tokens = getattr(usage, "completion_tokens", None)
                            tokens_in = (
                                prompt_tokens if prompt_tokens is not None
                                else litellm.token_counter(model=model, messages=messages)
                            )
                            tokens_out = (
                                completion_tokens if completion_tokens is not None
                                else litellm.token_counter(model=model, text=output)
                            )
                            if usage is None:
                                usd = litellm.completion_cost(
                                    model=model, messages=messages, completion=output,
                                )
                            else:
                                usd = litellm.completion_cost(model=model, completion_response=complete)
                            cost = (Decimal(str(usd)) * self.usd_cny_rate).quantize(
                                Decimal("0.0001"), rounding=ROUND_HALF_UP,
                            )
                        except Exception:
                            # Keep the best available counts without masking a stream error.
                            pass
                        result.usage = Usage(tokens_in, tokens_out, cost)

        return ChatStream(iterate)


class FakeLLM:
    def __init__(
        self, replies: Mapping[str, str] | None = None,
        *, cost_cny: Decimal = Decimal("0.0123"), delay: float = 0,
    ) -> None:
        self.replies = dict(replies or {})
        self.cost_cny = cost_cny
        self.delay = delay

    async def stream_chat(
        self, model: str, messages: list[ChatMessage], temperature: float,
        max_tokens: int | None,
    ) -> ChatStream:
        reply = self.replies.get(model)
        if reply is None:
            request = messages[-1]["content"] if messages else ""
            speaker = re.match(r"现在轮到你（(.+?)），本轮要求：", request)
            identity = speaker.group(1) if speaker else model
            round_number = re.search(r"第 (\d+) 轮", request.split("\n", 1)[0])
            stage = f"第 {round_number[1]} 轮" if round_number else "汇总"
            response = "我先回应刚才的插话，再补充一个可执行的建议。" if "请先回应：" in request else "我会结合讨论补充一个可执行的建议，先从最容易验证的步骤开始。"
            reply = f"（{identity} {stage}）{response}"
        if max_tokens is not None:
            reply = reply[:max_tokens]

        async def iterate(result: ChatStream) -> AsyncGenerator[str, None]:
            emitted = 0
            try:
                for character in reply:
                    if self.delay:
                        await asyncio.sleep(self.delay)
                    emitted += 1
                    yield character
            finally:
                result.usage = Usage(sum(len(m["content"]) for m in messages), emitted, self.cost_cny)

        return ChatStream(iterate)
