"""诊断：经中转站调用 Claude 时带上工具。读取 backend/.env，不打印任何 Key。
用法：python diag_tools.py <backend 目录> [模型名]"""
import asyncio
import os
import sys
from pathlib import Path

from dotenv import dotenv_values

backend = Path(sys.argv[1])
for k, v in dotenv_values(backend / ".env").items():
    if v and not os.environ.get(k):
        os.environ[k] = v
model = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("ROUNDTABLE_ANTHROPIC_MODEL", "anthropic/claude-haiku-5-5")
secrets = [v for k, v in os.environ.items() if v and k.endswith(("_KEY", "_TOKEN"))]


def hide(text):
    text = str(text)
    for s in secrets:
        text = text.replace(s, "[已隐藏]")
    return text[:800]


import litellm  # noqa: E402

TOOL = {"type": "function", "function": {"name": "run_code", "description": "运行代码",
        "parameters": {"type": "object", "properties": {"code": {"type": "string"}}, "required": ["code"]}}}
msgs = [{"role": "user", "content": "用工具运行 print(1+1)"}]
print("模型：", model, "| 地址：", os.environ.get("ANTHROPIC_BASE_URL"))


async def case(title, **kw):
    print(f"\n[{title}]")
    try:
        r = await litellm.acompletion(model=model, messages=msgs, max_tokens=2000, **kw)
        m = r.choices[0].message
        print("  成功：finish_reason", r.choices[0].finish_reason, "| tool_calls", bool(m.tool_calls), "| 文字", repr((m.content or "")[:80]))
    except Exception as e:
        print("  失败：", type(e).__name__, hide(e))


async def main():
    await case("不带工具")
    await case("带工具，非流式", tools=[TOOL])
    await case("带工具，tool_choice=auto", tools=[TOOL], tool_choice="auto")
    print("\n[带工具，流式]")
    try:
        r = await litellm.acompletion(model=model, messages=msgs, max_tokens=2000, tools=[TOOL], stream=True,
                                      stream_options={"include_usage": True})
        n, args, finish = 0, "", None
        async for c in r:
            n += 1
            if c.choices:
                d = c.choices[0].delta
                for tc in (d.tool_calls or []):
                    args += tc.function.arguments or ""
                finish = c.choices[0].finish_reason or finish
        print("  成功：", n, "块，finish_reason", finish, "| 工具参数", repr(args[:120]))
    except Exception as e:
        print("  失败：", type(e).__name__, hide(e))


asyncio.run(main())
