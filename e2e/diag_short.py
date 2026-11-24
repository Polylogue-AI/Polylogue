"""诊断：用圆桌模式第一轮的真实提示词调用 Claude，查看结束原因。不打印 Key。
用法：python diag_short.py <backend 目录>"""
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from dotenv import dotenv_values  # noqa: E402

for k, v in dotenv_values(Path(sys.argv[1]) / ".env").items():
    if v and not os.environ.get(k):
        os.environ[k] = v

import litellm  # noqa: E402
from app.modes.base import Member, build_prompt  # noqa: E402
from app.modes.roundtable import Roundtable  # noqa: E402

model = os.environ["ROUNDTABLE_ANTHROPIC_MODEL"]
members = [Member("ai_claude", "Claude", model, "方案设计", "提出具体方案和可执行的步骤。"),
           Member("ai_x", "X", "x/x", "评估", "评估。")]
mode = Roundtable(members, 2)
turn = mode.next_speaker()
prompt = build_prompt(turn, "怎么组织一次读书会？", [])
print("== 提示词 ==")
for m in prompt:
    print(f"[{m['role']}] {m['content'][:120]!r}")


async def main():
    for stream in (False, True):
        print(f"\n== {'流式' if stream else '非流式'}，max_tokens=4000 ==")
        r = await litellm.acompletion(model=model, messages=prompt, temperature=0.5, max_tokens=4000, stream=stream, drop_params=True,
                                      **({"stream_options": {"include_usage": True}} if stream else {}))
        if not stream:
            print("finish_reason:", r.choices[0].finish_reason, "| 用量:", r.usage.prompt_tokens, "/", r.usage.completion_tokens)
            msg = r.choices[0].message
            print("正文:", repr((msg.content or "")[:300]))
            print("思考内容长度:", len(getattr(msg, "reasoning_content", None) or ""))
        else:
            text, finish, usage = "", None, None
            async for c in r:
                if c.choices:
                    text += c.choices[0].delta.content or ""
                    finish = c.choices[0].finish_reason or finish
                usage = getattr(c, "usage", None) or usage
            print("finish_reason:", finish, "| 用量:", usage and (usage.prompt_tokens, usage.completion_tokens))
            print("正文:", repr(text[:300]))


asyncio.run(main())
