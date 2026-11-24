"""诊断：经中转站调用 Anthropic。读取 backend/.env，不打印任何 Key。
用法：python -I diag_relay.py <backend 目录> [模型名]"""
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
    return text[:600]


import litellm  # noqa: E402

print("模型：", model)
print("地址：", os.environ.get("ANTHROPIC_BASE_URL"))
print("认证：", "AUTH_TOKEN（Bearer）" if os.environ.get("ANTHROPIC_AUTH_TOKEN") else "API_KEY")
msgs = [{"role": "user", "content": "用一句话回答：1+1 等于几？"}]


async def main():
    print("\n[1] 非流式调用")
    try:
        r = await litellm.acompletion(model=model, messages=msgs, max_tokens=50)
        print("  回复：", hide(r.choices[0].message.content))
        print("  用量：", r.usage.prompt_tokens, "/", r.usage.completion_tokens)
    except Exception as e:
        print("  失败：", type(e).__name__, hide(e))

    print("\n[2] 流式调用")
    try:
        resp = await litellm.acompletion(model=model, messages=msgs, max_tokens=50, stream=True,
                                         stream_options={"include_usage": True})
        n, text = 0, ""
        async for chunk in resp:
            n += 1
            if chunk.choices and chunk.choices[0].delta.content:
                text += chunk.choices[0].delta.content
            if n <= 3:
                print("  块", n, ":", hide(chunk)[:200])
        print("  共", n, "块，正文：", repr(hide(text)))
    except Exception as e:
        print("  失败：", type(e).__name__, hide(e))


asyncio.run(main())
