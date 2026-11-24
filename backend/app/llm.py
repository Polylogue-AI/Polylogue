"""Streaming chat with per-call usage, independent of the discussion mode."""

import asyncio
import json
import re
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from os import environ, getenv
from threading import Lock
from typing import NotRequired, Protocol, TypedDict
from urllib.parse import quote, quote_plus, urlsplit


def supports_temperature(model: str) -> bool:
    provider, _, name = model.lower().partition("/")
    if provider == "anthropic":
        return re.match(r"claude-[a-z]+-5-5(?:-|$)", name) is None
    if provider == "openai":
        return not (name.startswith("gpt-5") or re.match(r"o[0-9]+(?:-|$)", name))
    return True


def supports_tools(llm, model: str, overrides=()) -> bool:
    capability = getattr(llm, "supports_tools", None)
    return model in overrides or (capability is not None and capability(model))


def model_error_detail(error: Exception) -> str:
    detail = str(error)
    secrets = {
        encoded for name, value in environ.items()
        if value and name.upper().endswith(("_API_KEY", "_API_TOKEN", "_AUTH_TOKEN", "_ACCESS_TOKEN", "_SECRET_ACCESS_KEY"))
        for encoded in (value, quote(value, safe=""), quote_plus(value))
    }
    for secret in sorted(secrets, key=len, reverse=True):
        detail = detail.replace(secret, "[已隐藏]")
    return detail


def anthropic_endpoint() -> str:
    configured = getenv("ANTHROPIC_API_BASE") or getenv("ANTHROPIC_BASE_URL") or "https://api.anthropic.com"
    try:
        url = urlsplit(configured)
        if url.scheme in {"http", "https"} and url.hostname:
            host = f"[{url.hostname}]" if ":" in url.hostname else url.hostname
            return f"{url.scheme}://{host}" + (f":{url.port}" if url.port else "")
    except ValueError:
        pass
    return "地址无效"


class ChatMessage(TypedDict):
    role: str
    content: str
    tool_calls: NotRequired[list[dict]]
    tool_call_id: NotRequired[str]


@dataclass(frozen=True)
class Usage:
    tokens_in: int
    tokens_out: int
    cost_cny: Decimal | None


class ChatStream(AsyncIterator[str]):
    """An async iterator whose own usage is available after it closes."""

    def __init__(self, iterate: Callable[["ChatStream"], AsyncGenerator[str, None]]) -> None:
        self.usage: Usage | None = None
        self.truncated = False
        self.tool_calls: list[dict] = []
        self._iterator = iterate(self)

    async def __anext__(self) -> str:
        return await anext(self._iterator)

    async def aclose(self) -> None:
        await self._iterator.aclose()


class LLM(Protocol):
    async def stream_chat(
        self, model: str, messages: list[ChatMessage], temperature: float,
        max_tokens: int | None, *, tools: list[dict] | None = None,
    ) -> ChatStream: ...


class LiteLLM:
    def __init__(self, usd_cny_rate: Decimal) -> None:
        if not usd_cny_rate.is_finite() or usd_cny_rate <= 0:
            raise ValueError("USD_CNY_RATE 必须是大于零的数字")
        import litellm

        litellm.suppress_debug_info = True
        self.usd_cny_rate = usd_cny_rate
        self.checks: dict[str, bool] = {}
        self.provider_checks: dict[str, bool] = {}
        self.tool_capabilities: dict[str, bool] = {}
        self.tool_capability_lock = Lock()

    def record_check(self, model, available):
        self.checks[model] = available
        self.provider_checks[model.partition("/")[0]] = available

    def provider_available(self, model, provider):
        checked = self.provider_checks.get(provider)
        if provider in {"ollama", "ollama_chat"}:
            return checked is True
        if checked is False:
            return False
        from litellm import validate_environment

        try:
            return bool(validate_environment(model).get("keys_in_environment"))
        except Exception:
            return False

    def supports_tools(self, model):
        if model.partition("/")[0] in {"ollama", "ollama_chat"}:
            # Ollama capability discovery contacts the local service. Use TOOL_MODELS to opt in.
            return False
        from litellm import supports_function_calling

        with self.tool_capability_lock:
            if model not in self.tool_capabilities:
                try:
                    self.tool_capabilities[model] = bool(supports_function_calling(model=model))
                except Exception:
                    self.tool_capabilities[model] = False
            return self.tool_capabilities[model]

    def estimate_usage(self, model, messages, content, calls, tools):
        from litellm import cost_per_token, token_counter

        from .context import estimate_tokens

        request = list(messages)
        if tools:
            request.append({"role": "system", "content": json.dumps(tools, ensure_ascii=False)})
        output = content + (json.dumps(calls, ensure_ascii=False) if calls else "")
        try:
            tokens_in = token_counter(model=model, messages=request)
            tokens_out = token_counter(model=model, text=output)
        except Exception:
            tokens_in = estimate_tokens(request)
            tokens_out = estimate_tokens([{"content": output}]) if output else 0
        try:
            costs = cost_per_token(model=model, prompt_tokens=tokens_in, completion_tokens=tokens_out)
            cost = (sum(Decimal(str(amount)) for amount in costs) * self.usd_cny_rate).quantize(
                Decimal("0.0001"), rounding=ROUND_HALF_UP,
            )
        except Exception:
            cost = None  # Unknown pricing is distinct from a zero-cost call.
        return Usage(tokens_in, tokens_out, cost)

    def count_tokens(self, model, messages):
        import litellm

        return litellm.token_counter(model=model, messages=messages)

    def cheapest(self, members, messages):
        import litellm

        from .context import estimate_tokens

        priced = []
        for member in members:
            try:
                model = member.model
                checked = self.checks.get(model)
                if checked is False or (model.startswith(("ollama/", "ollama_chat/")) and checked is not True):
                    continue
                if not litellm.validate_environment(model)["keys_in_environment"]:
                    continue
                info = litellm.get_model_info(model)
                try:
                    tokens = self.count_tokens(model, messages)
                except Exception:
                    tokens = estimate_tokens(messages)
                cost = info["input_cost_per_token"] * tokens + info["output_cost_per_token"] * 768
                priced.append((cost, member))
            except (KeyError, TypeError, ValueError):
                continue
            except litellm.exceptions.NotFoundError:
                continue
        return min(priced, key=lambda item: item[0])[1] if priced else None

    async def stream_chat(
        self, model: str, messages: list[ChatMessage], temperature: float,
        max_tokens: int | None, *, tools: list[dict] | None = None,
    ) -> ChatStream:
        import litellm

        async def iterate(result: ChatStream) -> AsyncGenerator[str, None]:
            options = {"max_tokens": max_tokens} if max_tokens is not None else {}
            if supports_temperature(model):
                options["temperature"] = temperature
            if model == "deepseek/deepseek-flash":
                # Use the provider's direct-answer mode for this model.
                options["thinking"] = {"type": "disabled"}
            if tools:
                options["tools"] = tools
            calls = {}
            completed = False
            chunks = []
            parts: list[str] = []
            try:
                response = await litellm.acompletion(
                    model=model, messages=messages,
                    stream=True, stream_options={"include_usage": True}, drop_params=True, **options,
                )
            except Exception:
                self.record_check(model, False)
                raise
            try:
                async for chunk in response:
                    chunks.append(chunk)
                    if chunk.choices:
                        choice = chunk.choices[0]
                        if choice.finish_reason == "length":
                            result.truncated = True
                        for position, fragment in enumerate(choice.delta.tool_calls or []):
                            index = fragment.index if fragment.index is not None else position
                            call = calls.setdefault(index, {
                                "id": f"call_{index}", "type": "function",
                                "function": {"name": "", "arguments": ""},
                            })
                            if fragment.id:
                                call["id"] = fragment.id
                            if function := fragment.function:
                                if function.name and function.name != call["function"]["name"]:
                                    call["function"]["name"] += function.name
                                if function.arguments:
                                    arguments = function.arguments
                                    call["function"]["arguments"] += (
                                        arguments if isinstance(arguments, str) else json.dumps(arguments)
                                    )
                        if delta := choice.delta.content:
                            parts.append(delta)
                            yield delta
                if tools:
                    result.tool_calls = [calls[index] for index in sorted(calls)]
                self.record_check(model, bool("".join(parts).strip() or result.tool_calls))
                completed = True
            except Exception:
                self.record_check(model, False)
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
                        # LiteLLM can synthesize usage when assembling chunks, so check the wire data.
                        reported_usage = any(
                            getattr(getattr(chunk, "usage", None), "prompt_tokens", None) is not None
                            and getattr(getattr(chunk, "usage", None), "completion_tokens", None) is not None
                            for chunk in chunks
                        )
                        if reported_usage or not completed:
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
        *, cost_cny: Decimal = Decimal("0.0123"), delay: float = 0, thinking_tokens: int = 0,
        tool_script: Callable | None = None,
    ) -> None:
        self.replies = dict(replies or {})
        self.cost_cny = cost_cny
        self.delay = delay
        self.thinking_tokens = thinking_tokens
        self.tool_script = tool_script

    @staticmethod
    def supports_tools(model):
        return True

    def cheapest(self, members, messages):
        return next(iter(members), None)

    def estimate_usage(self, model, messages, content, calls, tools):
        from .context import estimate_tokens

        request = list(messages)
        if tools:
            request.append({"content": json.dumps(tools, ensure_ascii=False)})
        output = content + (json.dumps(calls, ensure_ascii=False) if calls else "")
        return Usage(estimate_tokens(request), estimate_tokens([{"content": output}]), self.cost_cny)

    async def stream_chat(
        self, model: str, messages: list[ChatMessage], temperature: float,
        max_tokens: int | None, *, tools: list[dict] | None = None,
    ) -> ChatStream:
        scripted = self.tool_script(model, messages, tools) if self.tool_script else None
        reply, calls = scripted if scripted is not None else (self.replies.get(model), [])
        if reply is None:
            request = messages[-1]["content"] if messages else ""
            speaker = re.match(r"现在轮到你（(.+?)），本轮要求：", request)
            identity = speaker.group(1) if speaker else model
            goal = request[speaker.end():] if speaker else request
            round_number = re.search(r"第 (\d+) 轮", goal.split("\n", 1)[0])
            stage = f"第 {round_number[1]} 轮" if round_number else "发言"
            response = "我会结合讨论补充一个可执行的建议，先从最容易验证的步骤开始。"
            if goal.startswith("独立回答"):
                stage, response = "独立回答", "我的建议是先做小规模试点，结果还需要数据验证。"
            elif goal.startswith("完成这项任务"):
                stage, response = "执行稿", "已整理目标、执行步骤和验收条件。"
            elif goal.startswith(("汇总讨论", "合并通过审查")):
                stage, response = "汇总", "综合本次讨论，先确认目标，再按明确的步骤推进。"
            elif goal.startswith("给出最终裁决"):
                stage, response = "最终裁决", "综合各回合，正方的论据更完整，反方提出的风险仍需验证。"
            elif round_number and "正方陈词" in goal.split("\n", 1)[0]:
                response = "正方主张先试行，因为小规模试点能较快验证成效。"
            elif round_number and "反方陈词" in goal.split("\n", 1)[0]:
                response = "反方建议先确认资源与风险，避免试点结论失真。"
            if "请先回应：" in request:
                response = "我先回应刚才的插话。" + response
            reply = f"（{identity} {stage}）{response}"
            if goal.startswith('输出任务列表。仅返回 JSON'):
                reply = json.dumps({"tasks": ["梳理目标与限制", "制定行动计划"]}, ensure_ascii=False)
            elif goal.startswith('给出审查结论。仅返回 JSON'):
                reply = json.dumps({"verdict": "approved", "comment": "步骤明确，可以合并。"}, ensure_ascii=False)
            elif goal.startswith('逐个点评其他匿名回答。仅返回 JSON'):
                labels = [match[1] for item in messages[:-1] if (match := re.match(r"\[(回答 [A-Z]+)\]：", item["content"]))]
                reply = json.dumps({"reviews": {label: {"score": 8, "comment": "建议清楚。"} for label in labels}}, ensure_ascii=False)
            elif '给出结论、共识与分歧。仅返回 JSON' in goal.split("\n", 1)[0]:
                reply = json.dumps({"conclusion": "先试行，再根据反馈调整。", "agreements": ["先明确目标"],
                                    "disagreements": ["执行节奏有待比较"]}, ensure_ascii=False)
            elif '正方倾向分。仅返回 JSON' in goal.split("\n", 1)[0]:
                reply = json.dumps({"score_pro": 58, "comment": "本轮正方的论据更完整。"}, ensure_ascii=False)
            elif messages and messages[0]["content"].startswith("压缩早期讨论"):
                reply = "早期讨论明确了目标、实施步骤与待验证风险。"
        available = len(reply) if max_tokens is None else max(0, max_tokens - self.thinking_tokens)
        truncated = len(reply) > available
        reply = reply[:available]

        async def iterate(result: ChatStream) -> AsyncGenerator[str, None]:
            emitted = 0
            try:
                for character in reply:
                    if self.delay:
                        await asyncio.sleep(self.delay)
                    emitted += 1
                    yield character
                result.truncated = truncated
                result.tool_calls = calls if tools else []
            finally:
                thinking = self.thinking_tokens if max_tokens is None else min(self.thinking_tokens, max_tokens)
                result.usage = Usage(sum(len(m["content"]) for m in messages), thinking + emitted, self.cost_cny)

        return ChatStream(iterate)
