"""真实模型跑四种模式。连接已启动的后端（LLM_MODE=real），把每场讨论的完整记录写成 Markdown。
用法：python real_modes.py <输出目录> [模式,模式...]"""
import asyncio
import json
import sys
import time
from pathlib import Path

import httpx
import websockets

BASE = "http://localhost:8000"
OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
AIS = ["ai_claude", "ai_gpt", "ai_deepseek"]
ROOMS = [
    ("round", "圆桌", "怎么组织一次读书会？请给出可执行的方案。", 2),
    ("pipe", "流水线", "为一个 8 人的读书会写一份首次活动方案：目标、议程、分工、风险。", 1),
    ("cross", "交叉验证", "一个成年人每天大约需要喝多少水？请给出依据和不确定之处。", 1),
    ("debate", "辩论", "读书会应该要求成员每次都读完整本书", 2),
]
ONLY = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None
DONE = {"finished", "error", "budget_exceeded"}


async def run_room(client, cookie, mode, label, topic, rounds, names):
    r = await client.post("/api/rooms", json=dict(topic=topic, mode=mode, ai_member_ids=AIS, human_user_ids=[],
                                                   rounds=rounds, budget_cny=3, auto_start=False))
    r.raise_for_status()
    room = r.json()
    duties = {s["id"]: s["duty"] for s in room["seats"] if s["kind"] == "ai"}
    messages, states, started = {}, [], time.time()
    async with websockets.connect(f"ws://localhost:8000/ws/rooms/{room['id']}",
                                  additional_headers={"Cookie": cookie}, max_size=None) as ws:
        await ws.send(json.dumps({"type": "hello", "last_seq": 0}))
        await ws.send(json.dumps({"type": "start"}))
        status = None
        while status not in DONE:
            ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=600))
            t = ev["type"]
            if t == "snapshot":
                for m in ev["messages"]:
                    messages[m["id"]] = m
            elif t in ("message", "message_start"):
                m = ev["message"]
                messages[m["id"]] = m
            elif t == "message_end":
                messages[ev["id"]].update(content=ev["content"], cost_cny=ev["cost_cny"],
                                          interrupted=ev["interrupted"], streaming=False,
                                          meta=ev.get("meta") or messages[ev["id"]]["meta"])
            elif t == "state":
                status = ev["state"]["status"]
                states.append(ev["state"])
            elif t == "error":
                print(f"  [{label}] 错误事件：{ev['message']}")
    final = states[-1] if states else {}
    msgs = sorted(messages.values(), key=lambda m: m["seq"])
    return dict(mode=mode, label=label, topic=topic, duties=duties, status=status, state=final, messages=msgs,
                seconds=round(time.time() - started), names=names)


def report(res):
    names, st, msgs = res["names"], res["state"], res["messages"]
    system = [m["content"] for m in msgs if m["kind"] == "system"]
    lines = [f"# {res['label']}：{res['topic']}", "",
             f"- 状态：**{res['status']}**　用时 {res['seconds']} 秒　费用 ¥{st.get('cost_cny', 0):.4f}",
             "- 职责：" + "，".join(f"{names[k]} = {v}" for k, v in res["duties"].items())]
    if system:
        lines.append("- 系统消息：" + "；".join(system))
    ms = st.get("mode_state") or {}
    if ms.get("tasks"):
        lines.append("- 任务：" + "；".join(f"{t['title']}（{t['stage']}/{t['status']}，返工 {t['rework_count']}）" for t in ms["tasks"]))
    if "score_pro" in ms:
        lines.append(f"- 裁判最终倾向分（正方）：{ms['score_pro']}")
    lines += ["", "---", ""]
    for m in msgs:
        who = names.get(m["author_id"], "系统" if m["author_id"] is None else m["author_id"])
        tag = " / ".join(f"{k}={v}" for k, v in (m.get("meta") or {}).items() if k in ("phase", "side", "verdict", "anon_label"))
        flags = ("，被截断/打断" if m.get("interrupted") else "")
        cost = f"，¥{m['cost_cny']:.4f}" if m.get("cost_cny") is not None else ""
        lines.append(f"### {m['seq']}. {who}（{m['kind']}{'，' + tag if tag else ''}{cost}{flags}）\n")
        lines.append(m["content"] or "（空）")
        meta = m.get("meta") or {}
        for key, title in (("agreements", "共识"), ("disagreements", "分歧")):
            if meta.get(key):
                lines.append(f"\n**{title}：**\n" + "\n".join(f"- {x}" for x in meta[key]))
        lines.append("")
    return "\n".join(lines)


def structured_summary(res):
    """统计需要 JSON 的步骤：成功的看对应消息/元数据，失败的看"调用失败"系统消息。"""
    msgs, mode = res["messages"], res["mode"]
    fails = [m["content"] for m in msgs if m["kind"] == "system" and "失败" in m["content"]]
    ok = {}
    if mode == "pipe":
        ok["规划"] = sum(1 for m in msgs if m["content"].startswith("### 任务计划"))
        ok["审查"] = sum(1 for m in msgs if (m.get("meta") or {}).get("verdict"))
    if mode == "cross":
        ok["互评"] = sum(1 for m in msgs if (m.get("meta") or {}).get("phase") == "review")
        ok["裁判结论"] = sum(1 for m in msgs if m["kind"] == "verdict" and (m.get("meta") or {}).get("agreements") is not None)
    if mode == "debate":
        ok["裁判打分"] = sum(1 for m in msgs if (m.get("meta") or {}).get("side") == "judge" and m["kind"] != "verdict")
    return ok, fails


async def main():
    async with httpx.AsyncClient(base_url=BASE, timeout=60) as client:
        r = await client.post("/api/auth/login", json={"invite_code": "TBLE27", "name": "林"})
        r.raise_for_status()
        cookie = "rt_session=" + client.cookies["rt_session"]
        # 真实模式的空数据库没有成员，先按 .env 里的模型创建三位
        specs = [
            ("Claude", "C", "#C9842F", "anthropic/claude-haiku-5-5", "产品顾问", "先判断用户真正要解决的问题，再给建议。"),
            ("GPT", "G", "#14996F", "openai/gpt-6.1-sol", "工程评估", "评估实现难度、时间和维护成本。"),
            ("DeepSeek", "D", "#36458F", "deepseek/deepseek-flash", "唱反调", "找出前面观点中最薄弱的地方。"),
        ]
        AIS.clear()
        for name, short, color, model, role, prompt in specs:
            r = await client.post("/api/members", json=dict(name=name, short=short, color=color, model=model, role=role,
                                   system_prompt=prompt, temperature=0.5, max_chars=300, monthly_budget_cny=None, can_mention=False))
            r.raise_for_status()
            AIS.append(r.json()["id"])
        members = {m["id"]: m for m in (await client.get("/api/members")).json()}
        names = {k: members[k]["name"] for k in AIS}
        print("成员：", "，".join(f"{members[k]['name']}={members[k]['model']}" for k in AIS))
        total = 0.0
        for mode, label, topic, rounds in ROOMS:
            if ONLY and mode not in ONLY:
                continue
            print(f"\n== {label} 开始 ==", flush=True)
            res = await run_room(client, cookie, mode, label, topic, rounds, names)
            (OUT / f"{mode}.md").write_text(report(res), encoding="utf-8")
            ok, fails = structured_summary(res)
            cost = res["state"].get("cost_cny", 0)
            total += cost
            print(f"   状态 {res['status']}，{len(res['messages'])} 条消息，{res['seconds']} 秒，¥{cost:.4f}")
            if ok:
                print("   JSON 步骤成功：" + "，".join(f"{k} {v}" for k, v in ok.items()))
            print("   调用失败：" + ("；".join(fails) if fails else "无"))
            cut = [m for m in res["messages"] if m.get("interrupted")]
            if cut:
                print(f"   被截断/打断的消息：{len(cut)} 条")
        print(f"\n四种模式合计 ¥{total:.4f}")


asyncio.run(main())
