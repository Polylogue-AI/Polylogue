"""真实模型 + 真实 Docker：三位成员都允许运行代码，跑一轮圆桌，检查工具调用和 run 消息。
用法：python real_tools.py <输出文件>"""
import asyncio
import json
import sys
import time

import httpx
import websockets

BASE = "http://localhost:8000"
TOPIC = ("写一个 Python 函数 is_palindrome(s)，忽略大小写和非字母数字字符，判断是否回文。"
         "请先用 run_code 工具运行几个测试用例验证，再给出最终代码和测试结果。")


async def main():
    async with httpx.AsyncClient(base_url=BASE, timeout=60) as client:
        (await client.post("/api/auth/login", json={"invite_code": "TBLE27", "name": "林"})).raise_for_status()
        cookie = "rt_session=" + client.cookies["rt_session"]
        print("沙箱：", (await client.get("/api/sandbox")).json())
        models = {m["id"]: m for m in (await client.get("/api/models")).json()}
        ids, names = [], {}
        for name, model in (("Claude", "anthropic/claude-haiku-5-5"), ("GPT", "openai/gpt-6.1-sol"), ("DeepSeek", "deepseek/deepseek-flash")):
            print(f"  {model} supports_tools={models.get(model, {}).get('supports_tools')}")
            r = await client.post("/api/members", json=dict(name=name, short=name[0], color="#C9842F", model=model, role="程序员",
                                   system_prompt="你是程序员。", temperature=0.5, max_chars=None, monthly_budget_cny=None,
                                   can_mention=False, can_run_code=True))
            r.raise_for_status()
            ids.append(r.json()["id"]); names[r.json()["id"]] = name
        r = await client.post("/api/rooms", json=dict(topic=TOPIC, mode="round", ai_member_ids=ids, human_user_ids=[],
                                                       rounds=1, budget_cny=2, auto_start=False))
        r.raise_for_status()
        room = r.json()
        msgs, status, started = {}, None, time.time()
        async with websockets.connect(f"ws://localhost:8000/ws/rooms/{room['id']}", additional_headers={"Cookie": cookie}, max_size=None) as ws:
            await ws.send(json.dumps({"type": "hello", "last_seq": 0}))
            await ws.send(json.dumps({"type": "start"}))
            while status not in {"finished", "error", "budget_exceeded"}:
                ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=600))
                t = ev["type"]
                if t in ("message", "message_start"):
                    msgs[ev["message"]["id"]] = ev["message"]
                elif t == "message_end":
                    msgs[ev["id"]].update(content=ev["content"], cost_cny=ev["cost_cny"], interrupted=ev["interrupted"],
                                          meta=ev.get("meta") or msgs[ev["id"]]["meta"])
                elif t == "state":
                    status = ev["state"]["status"]; cost = ev["state"]["cost_cny"]
                elif t == "error":
                    print("  错误事件：", ev)
        lines = [f"# 代码运行实测：{TOPIC}", "", f"状态 {status}，用时 {round(time.time() - started)} 秒，费用 ¥{cost:.4f}", ""]
        for m in sorted(msgs.values(), key=lambda m: m["seq"]):
            who = names.get(m["author_id"], "系统")
            run = (m.get("meta") or {}).get("run")
            cost_s = f"，¥{m['cost_cny']:.4f}" if m.get("cost_cny") is not None else ""
            if run:
                lines.append(f"### {m['seq']}. {who}（run：{run['language']} {run['status']} 退出码 {run['exit_code']}，{run['duration_ms']} ms{cost_s}）\n")
                for f in run["files"]:
                    lines.append(f"`{f['path']}`\n```\n{f['content']}\n```")
                lines.append(f"stdout:\n```\n{run['stdout']}\n```\nstderr:\n```\n{run['stderr']}\n```\n")
            else:
                lines.append(f"### {m['seq']}. {who}（{m['kind']}{cost_s}{'，被打断' if m.get('interrupted') else ''}）\n\n{m['content']}\n")
        open(sys.argv[1], "w", encoding="utf-8").write("\n".join(lines))
        print(f"状态 {status}，{len(msgs)} 条消息，¥{cost:.4f}")
        for m in sorted(msgs.values(), key=lambda m: m["seq"]):
            run = (m.get("meta") or {}).get("run")
            print(f"  {m['seq']:>2} {names.get(m['author_id'], '系统'):<8} {m['kind']:<6}",
                  f"{run['language']} {run['status']} exit={run['exit_code']}" if run else (m["content"][:60].replace("\n", " ")))


asyncio.run(main())
