"""复现：交叉验证并发回答阶段 interrupt → resume 后房间进入 error。
在 backend 目录外运行，不修改后端代码；只把 Room.run 吞掉的异常打印出来。"""
import sys
import traceback

sys.path.insert(0, sys.argv[1])  # backend 目录

from fastapi.testclient import TestClient

from app import room as room_module
from app.config import Settings
from app.llm import FakeLLM
from app.main import create_app

original = room_module.run_room


async def traced(room, mode):
    try:
        return await original(room, mode)
    except BaseException:
        print("---- 被吞掉的异常 ----")
        traceback.print_exc()
        raise


room_module.run_room = traced

with TestClient(create_app(Settings(":memory:", "TABLE2", fake=True), FakeLLM(delay=0.02))) as client:
    client.post("/api/auth/login", json={"invite_code": "table2", "name": "管理员"})
    r = client.post("/api/rooms", json=dict(
        topic="远程办公效率更高吗？", mode="cross", rounds=1,
        ai_member_ids=["ai_claude", "ai_gemini", "ai_deepseek", "ai_gpt"], human_user_ids=[],
        budget_cny=10, auto_start=False)).json()
    with client.websocket_connect(f"/ws/rooms/{r['id']}") as ws:
        ws.send_json({"type": "hello", "last_seq": 0})
        ws.send_json({"type": "start"})
        deltas = 0
        while deltas < 3:
            ev = ws.receive_json()
            deltas += ev["type"] == "message_delta"
        ws.send_json({"type": "interrupt"})
        status = None
        while status != "paused":
            ev = ws.receive_json()
            if ev["type"] == "state":
                status = ev["state"]["status"]
        print("打断后状态：paused")
        ws.send_json({"type": "resume"})
        for _ in range(5000):
            ev = ws.receive_json()
            if ev["type"] == "message" and ev["message"]["kind"] == "system":
                print("system 消息：", ev["message"]["content"])
            if ev["type"] == "state" and ev["state"]["status"] in ("finished", "error", "budget_exceeded"):
                print("最终状态：", ev["state"]["status"], "| phase:", ev["state"]["mode_state"].get("phase"))
                break
