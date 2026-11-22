"""Run a three-model, two-round discussion from the command line."""

import argparse
import asyncio
import os
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .llm import FakeLLM, LiteLLM, anthropic_endpoint
from .modes.roundtable import Member, ModelCallError, Roundtable, Speech, total_cost


class ConfigurationError(Exception):
    pass


def _model_error_message(exc: ModelCallError) -> str:
    detail = str(exc.cause)
    secrets = {
        value for name, value in os.environ.items()
        if value and name.upper().endswith(("_API_KEY", "_AUTH_TOKEN", "_ACCESS_TOKEN", "_SECRET_ACCESS_KEY"))
    }
    for secret in sorted(secrets, key=len, reverse=True):
        detail = detail.replace(secret, "[已隐藏]")
    return f"模型调用失败：{exc}。{detail}"


async def run(topic: str, *, fake: bool) -> None:
    if fake:
        llm = FakeLLM()
    else:
        from dotenv import dotenv_values

        for name, value in dotenv_values(Path.cwd() / ".env").items():
            if value and not os.environ.get(name):
                os.environ[name] = value
        try:
            llm = LiteLLM(Decimal(os.environ.get("USD_CNY_RATE", "7.2")))
        except (ValueError, InvalidOperation):
            raise ConfigurationError("USD_CNY_RATE 必须是大于零的数字") from None

    members = [
        Member("ai_claude", "Claude", os.getenv("ROUNDTABLE_ANTHROPIC_MODEL", "anthropic/claude-haiku-5-5"),
               "方案设计", "提出具体方案和可执行的步骤。"),
        Member("ai_gpt", "GPT", os.getenv("ROUNDTABLE_OPENAI_MODEL", "openai/gpt-5-mini"),
               "可行性评估", "检查方案涉及的条件、成本和限制。"),
        Member("ai_deepseek", "DeepSeek", os.getenv("ROUNDTABLE_DEEPSEEK_MODEL", "deepseek/deepseek-flash"),
               "风险与汇总", "指出关键缺口，并将讨论收束成清晰的建议。"),
    ]
    if not fake:
        from litellm import validate_environment

        missing = []
        for member in members:
            validation = validate_environment(member.model)
            if not validation["keys_in_environment"]:
                keys = ", ".join(validation["missing_keys"])
                missing.append(f"{member.model}（{keys or '凭据或模型配置'}）")
        if missing:
            raise ConfigurationError(f"请检查 .env 中的模型配置：{'、'.join(missing)}")
        if members[0].model.startswith("anthropic/"):
            print(f"Anthropic API：{anthropic_endpoint()}", file=sys.stderr)

    speeches: list[Speech] = []
    async for speech in Roundtable(members, rounds=2).discuss(topic, llm):
        speeches.append(speech)
        heading = "汇总" if speech.turn.kind == "summary" else f"第 {speech.turn.round} 轮"
        print(f"[{heading}] {speech.turn.member.name}：{speech.content}", flush=True)

    cost = total_cost(speeches)
    print("预估总费用：未能计算" if cost is None else f"预估总费用：¥{cost:.4f}")


def main() -> int:
    parser = argparse.ArgumentParser(description="运行 AI 圆桌讨论")
    parser.add_argument("topic", metavar="问题")
    parser.add_argument("--fake", action="store_true", help="使用假模型，离线运行")
    args = parser.parse_args()
    if not args.topic.strip():
        parser.error("请输入讨论主题")
    try:
        asyncio.run(run(args.topic, fake=args.fake))
    except ConfigurationError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except ImportError:
        print("依赖加载失败，请检查是否已安装项目依赖。", file=sys.stderr)
        return 1
    except ModelCallError as exc:
        print(_model_error_message(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
