"""诊断：经中转站调用 OpenAI 模型。读取 backend/.env，不打印 Key。"""
import asyncio, os, sys
from pathlib import Path
from dotenv import dotenv_values
for k, v in dotenv_values(Path(sys.argv[1]) / ".env").items():
    if v and not os.environ.get(k):
        os.environ[k] = v
import litellm
model = os.environ.get("ROUNDTABLE_OPENAI_MODEL", "openai/gpt-5-mini")
secrets = [v for k, v in os.environ.items() if v and k.endswith(("_KEY", "_TOKEN"))]
def _h(t):
    t = str(t)
    for s in secrets: t = t.replace(s, "[已隐藏]")
    return t[:500]
print("模型：", model, "| 地址：", os.environ.get("OPENAI_BASE_URL"))
async def main():
    msgs = [{"role": "user", "content": "用一句话回答：1+1 等于几？"}]
    for stream in (False, True):
        try:
            r = await litellm.acompletion(model=model, messages=msgs, max_tokens=4000, stream=stream, drop_params=True,
                                          **({"stream_options": {"include_usage": True}} if stream else {}))
            if not stream:
                print("非流式：", r.choices[0].finish_reason, "|", r.usage.prompt_tokens, "/", r.usage.completion_tokens, "|", _h(r.choices[0].message.content))
                try: print("费用（美元）：", litellm.completion_cost(completion_response=r))
                except Exception as e: print("费用：算不出（", type(e).__name__, "）")
            else:
                text = ""
                async for c in r:
                    if c.choices: text += c.choices[0].delta.content or ""
                print("流式：", repr(_h(text)))
        except Exception as e:
            print("失败：", type(e).__name__, _h(e))
asyncio.run(main())
