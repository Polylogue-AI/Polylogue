import asyncio
from collections import deque
from contextlib import suppress
from dataclasses import fields

from .db import money, new_id, now
from .modes.roundtable import Member, Roundtable
from .orchestrator import run_room


def initial_state(room):
    return dict(status="idle", round=0, total_rounds=room["rounds"], speaker_id=None,
                next_speaker_id=None, cost_cny=0, budget_cny=room["budget_cny"], context_tokens=0,
                summarized_until_round=0, mode_state={})


class Room:
    def __init__(self, db, record, llm):
        self.db, self.record, self.llm = db, record, llm
        self.id = record["id"]
        self.state = db.get("room_states", self.id) or initial_state(record)
        self.seats = {seat["id"]: seat for seat in record["seats"]}
        self.clients = {}
        self.pending = []
        self.mentions = deque()
        self.seq = max((message["seq"] for message in db.messages(self.id)), default=0)
        self.active = None
        self.ready = asyncio.Event()
        self.task = None
        self.current_task = None
        self.cancel_current = False
        self.mode = None
        self.deleting = False

    def broadcast(self, event):
        for queue in self.clients:
            queue.put_nowait(event)

    def online(self):
        return list(dict.fromkeys(self.clients.values()))

    def join(self, user, last_seq):
        queue = asyncio.Queue()
        self.clients[queue] = user["id"]
        messages = [item for item in self.db.messages(self.id, last_seq) if not item["streaming"]]
        if self.active is not None:
            messages.append(dict(self.active))
            messages.sort(key=lambda message: message["seq"])
        queue.put_nowait(dict(type="snapshot", messages=messages, state=dict(self.state), online=self.online()))
        self.broadcast(dict(type="presence", online=self.online()))
        return queue

    def leave(self, queue):
        self.clients.pop(queue, None)
        self.broadcast(dict(type="presence", online=self.online()))

    def update(self, **changes):
        if all(self.state[key] == value for key, value in changes.items()):
            return
        self.state.update(changes)
        self.record.update(status=self.state["status"], cost_cny=self.state["cost_cny"],
                           updated_at=now().isoformat())
        with self.db.transaction():
            self.db.put("room_states", self.id, self.state)
            self.db.put("rooms", self.id, self.record)
        self.broadcast(dict(type="state", state=dict(self.state)))

    def new_message(self, author, kind, content, mentions=(), streaming=False):
        self.seq += 1
        return dict(id=new_id("m"), seq=self.seq, room_id=self.id, author_id=author, kind=kind,
                    content=content, round=self.state["round"], created_at=now().isoformat(),
                    mentions=list(mentions), reply_to=None, cost_cny=None, interrupted=False,
                    streaming=streaming, meta={})

    def save_message(self, message):
        with self.db.transaction():
            self.db.put_message(message)
            # An earlier streaming turn can finish after a later human message.
            if message["seq"] == self.seq:
                seat = self.seats.get(message["author_id"])
                person = seat or (self.db.get("users", message["author_id"]) if message["author_id"] else None)
                name = person["name"] if person else "系统"
                self.record["last_preview"] = f"{name}：{message['content'][:60]}"
            self.record["updated_at"] = now().isoformat()
            self.db.put("rooms", self.id, self.record)

    def add_message(self, author, kind, content, *, mentions=(), client_id=None):
        message = self.new_message(author, kind, content, mentions)
        self.save_message(message)
        event = dict(type="message", message=message)
        if client_id is not None:
            event["client_id"] = client_id
        self.broadcast(event)
        return message

    def begin_message(self, turn):
        message = self.new_message(turn.member.id, turn.kind, "", streaming=True)
        with self.db.transaction():
            self.db.put_message(message)
        self.active = message
        self.broadcast(dict(type="message_start", message=dict(message)))
        return message

    def delta(self, message, delta):
        message["content"] += delta
        self.broadcast(dict(type="message_delta", id=message["id"], delta=delta))

    def end_message(self, message, output, *, interrupted=False):
        usage = output.usage
        cost = money(usage.cost_cny) if usage and usage.cost_cny is not None else None
        message.update(content=output.content, cost_cny=None if cost is None else float(cost),
                       interrupted=interrupted, streaming=False)
        self.active = None
        total = money(self.state["cost_cny"])
        if usage:
            total += money(cost or 0)
        with self.db.transaction():
            self.db.put_message(message)
            if usage:
                self.db.charge(self.id, self.record["created_by"], message["author_id"], usage)
            if message["seq"] == self.seq and message["content"]:
                self.record["last_preview"] = f"{self.seats[message['author_id']]['name']}：{message['content'][:60]}"
            self.record.update(cost_cny=float(total), updated_at=now().isoformat())
            self.db.put("rooms", self.id, self.record)
            if cost is not None:
                self.db.put("room_states", self.id, dict(self.state, cost_cny=float(total)))
        self.broadcast(dict(type="message_end", id=message["id"], content=message["content"],
                            cost_cny=message["cost_cny"], interrupted=interrupted, meta=message["meta"]))
        if total != money(self.state["cost_cny"]):
            self.update(cost_cny=float(total))

    def budget_reason(self):
        if money(self.state["cost_cny"]) >= money(self.state["budget_cny"]):
            return "房间预算已用完，讨论停止。"
        creator_id = self.record["created_by"]
        creator = self.db.get("users", creator_id)
        limit = creator["monthly_limit_cny"]
        if limit is not None and self.db.monthly_cost(user=creator_id) >= money(limit):
            return "创建者的本月预算已用完，讨论停止。"
        return None

    def history(self, exclude=()):
        history = []
        pending = set(exclude)
        for message in self.db.messages(self.id):
            if message["kind"] not in {"chat", "summary"} or not message["content"] or message["id"] in pending:
                continue
            seat = self.seats.get(message["author_id"]) or self.db.get("users", message["author_id"])
            if seat:
                name = seat["name"] if seat.get("role") is None else f"{seat['name']}（{seat['role']}）"
                history.append((seat["id"], name, message["content"]))
        return history[-100:]

    def directions(self):
        return [message["content"] for message in self.db.messages(self.id) if message["kind"] == "steer"]

    def take_pending(self):
        pending, self.pending = self.pending, []
        return pending

    def peek_turn(self, mode):
        return mode.next_speaker(self.mentions[0] if self.mentions else None)

    def next_turn(self, mode):
        return mode.next_speaker(self.mentions.popleft() if self.mentions else None)

    def upcoming(self, mode, turn):
        position = mode.position
        mode.on_message_end(turn)
        next_turn = self.peek_turn(mode)
        mode.position = position
        return next_turn.member.id if next_turn else None

    def start(self):
        if self.task is not None and not self.task.done():
            return None
        if self.record["mode"] != "round":
            return "mode_unavailable", "当前版本只支持启动圆桌模式"
        if self.state["status"] == "budget_exceeded":
            return "budget_exceeded", "预算已用完"
        continuing = self.state["status"] == "finished"
        round_number = self.state["total_rounds"] + 1 if continuing else 1
        configs = self.db.get("room_members", self.id)
        members = [Member(**{field.name: config[field.name] for field in fields(Member)}) for config in configs]
        summarizer = next((seat["id"] for seat in self.seats.values() if seat["duty"] == "summarizer"), None)
        self.mode = Roundtable(members, 1 if continuing else self.record["rounds"],
                               summarizer_id=summarizer, first_round=round_number)
        if continuing:
            self.record["rounds"] = round_number
        self.ready.set()
        next_turn = self.peek_turn(self.mode)
        self.update(status="running", total_rounds=self.record["rounds"], next_speaker_id=next_turn.member.id)
        self.task = asyncio.create_task(self.run())
        return None

    async def run(self):
        try:
            await run_room(self, self.mode)
        except asyncio.CancelledError:
            self.update(status="error", speaker_id=None, next_speaker_id=None)
            raise
        except Exception:
            self.add_message(None, "system", "讨论遇到无法恢复的错误")
            self.update(status="error", speaker_id=None, next_speaker_id=None)

    async def stop(self):
        if self.task and not self.task.done():
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task
        for queue in self.clients:
            queue.put_nowait(None)

    def handle(self, user, event):
        if self.deleting:
            return "not_found", "房间不存在"
        kind = event.type
        if kind == "say":
            message = self.add_message(user["id"], "chat", event.content,
                                       mentions=event.mentions, client_id=event.client_id)
            self.pending.append((message["id"], f"[{user['name']}]：{event.content}"))
            self.mentions.extend(member for member in event.mentions
                                 if self.seats.get(member, {}).get("kind") == "ai")
            if self.mentions and self.state["status"] in {"idle", "finished"}:
                return self.start()
            if self.mode and self.mentions:
                self.update(next_speaker_id=self.mentions[0])
        elif kind == "steer":
            self.add_message(user["id"], "steer", event.content)
        elif kind == "start":
            return self.start()
        elif kind == "resume" and self.state["status"] == "paused":
            self.ready.set()
            self.update(status="running")
        elif kind in {"pause", "interrupt"} and self.state["status"] == "running":
            self.ready.clear()
            if self.current_task is None:
                self.update(status="paused", speaker_id=None)
            elif kind == "interrupt":
                self.cancel_current = True
                self.current_task.cancel()
        elif kind == "skip" and self.current_task and not self.current_task.done():
            self.cancel_current = True
            self.current_task.cancel()
        return None
