import asyncio
from contextlib import aclosing
from dataclasses import dataclass, field
from math import ceil

from .context import compression_prompt, estimate_tokens
from .llm import Usage
from .modes.base import StructuredReply, Turn, build_prompt
from .modes.roundtable import ModelCallError, Speech


@dataclass
class Output:
    parts: list[str] = field(default_factory=list)
    usage: Usage | None = None

    @property
    def content(self):
        return "".join(self.parts)


async def stream_turn(llm, turn, prompt, output, on_delta=None, *, max_tokens=None):
    member = turn.member
    if max_tokens is None:
        if member.max_chars is not None:
            max_tokens = ceil(member.max_chars * 1.5)
        if turn.parse is not None:
            max_tokens = max(1200, max_tokens or 0)
    stream = await llm.stream_chat(member.model, prompt, member.temperature, max_tokens)
    try:
        async with aclosing(stream):
            async for delta in stream:
                output.parts.append(delta)
                if on_delta:
                    on_delta(delta)
    finally:
        output.usage = stream.usage
    if not output.content.strip() or output.usage is None:
        raise RuntimeError("模型返回了空的流式响应")


async def discuss(mode, topic, llm):
    if not topic.strip():
        raise ValueError("请输入讨论主题")
    history = []
    while turn := mode.next_speaker():
        prompt = mode.build_prompt(turn, topic, history)
        output = Output()
        try:
            await stream_turn(llm, turn, prompt, output)
        except Exception as exc:
            raise ModelCallError(turn.member.model, exc) from exc
        history.append((turn.member.id, f"{turn.member.name}（{turn.member.role}）", output.content))
        mode.on_message_end(turn)
        yield Speech(turn, output.content, output.usage)



class BudgetStop(Exception):
    pass


class RoomFlow:
    def __init__(self, room):
        self.room = room
        self.successful = 0
        self.failures = 0
        self.blocked_reason = None

    def mode_state(self, **changes):
        self.room.update(mode_state=self.room.state["mode_state"] | changes)

    def check_budget(self):
        if reason := self.blocked_reason or self.room.budget_reason():
            raise BudgetStop(reason)

    def prompt(self, turn, pending, *, history=None):
        room = self.room
        if history is None:
            history = room.history(key for key, _ in pending)
        return build_prompt(
            turn, room.record["topic"], history,
            pending=[text for _, text in pending], directions=room.directions(), summary=room.context_summary(),
        )

    def count(self, model, messages):
        count = getattr(self.room.llm, "count_tokens", None)
        if count is not None:
            try:
                return count(model, messages)
            except Exception:
                pass
        return estimate_tokens(messages)

    async def compress(self, turns, pending):
        room = self.room
        public = [turn for turn in turns if turn.private_history is None]
        if not public:
            return
        max_round = min(turn.round for turn in public)
        completed = sorted({message["round"] for message in room.db.messages(room.id)
                            if room.state["summarized_until_round"] < message["round"] < max_round})
        select = getattr(room.llm, "cheapest", None)
        if select is None:
            return
        for number in completed:
            size = max(self.count(turn.member.model, self.prompt(turn, pending)) for turn in public)
            if size <= 20_000:
                return
            history = room.history((key for key, _ in pending), through_round=number)
            if not history:
                continue
            previous = room.context_summary()

            def messages():
                request = compression_prompt(room.record["topic"], previous, history)
                if directions := room.directions():
                    request[0]["content"] += "\n方向指示：\n" + "\n".join(directions)
                return request

            try:
                member = select(room.compression_members(), messages())
            except Exception:
                return
            if member is None:
                return
            result = await self.call(Turn(member, number), messages, visible=False, max_tokens=768)
            if self.blocked_reason:
                self.check_budget()
            if result is None:
                return
            room.update(summary=result.content, summarized_until_round=number)

    async def call(self, turn, make_prompt, *, visible=True, max_tokens=None, restart_on_interrupt=False):
        room = self.room
        member_id = turn.member.id
        failures = 0
        while failures < 2:
            await room.ready.wait()
            if reason := room.budget_reason():
                self.blocked_reason = reason
                return None
            output = Output()
            message = None

            def emit(delta):
                nonlocal message
                if message is None:
                    message = room.begin_message(turn)
                room.delta(message, delta)

            task = asyncio.create_task(stream_turn(
                room.llm, turn, make_prompt(), output, emit if visible and turn.parse is None else None,
                max_tokens=max_tokens,
            ))
            room.track(task, member_id if visible else None)
            try:
                await task
                result = turn.parse(output.content) if turn.parse else StructuredReply(output.content)
            except asyncio.CancelledError:
                if visible and message is None and output.content:
                    emit(output.content)
                room.end_message(member_id, message, output, interrupted=True)
                reason = room.cancelled_calls.get(task)
                if asyncio.current_task().cancelling() or reason is None:
                    raise
                if reason == "interrupt" and restart_on_interrupt:
                    continue
                return None
            except Exception:
                room.end_message(member_id, message, output, interrupted=True)
                failures += 1
                if failures == 2 and visible:
                    self.failures += 1
                    room.add_message(None, "system", f"{turn.member.name} 调用失败，已跳过")
            else:
                if visible and turn.parse is not None:
                    output.parts = [result.content]
                    emit(result.content)
                room.end_message(member_id, message, output, meta=result.meta)
                if visible:
                    self.successful += 1
                return result
            finally:
                room.untrack(task)
        return None

    async def play(self, turns, *, next_id=None, mentions=True, concurrent=False, started=None, completed=None):
        room = self.room
        await room.ready.wait()
        self.check_budget()
        if mentions:
            while room.mentions:
                member_id = room.mentions.popleft()
                await self.play([
                    Turn(room.members[member_id], turns[0].round, goal="回应刚才点名你的插话。",
                         private_history=() if turns[0].private_history is not None else None),
                ], next_id=room.mentions[0] if room.mentions else turns[0].member.id, mentions=False)

        pending = room.take_pending()
        await self.compress(turns, pending)
        await room.ready.wait()
        self.check_budget()
        pending.extend(room.take_pending())
        # A restarted parallel turn uses the same discussion history as its original attempt.
        history = room.history(key for key, _ in pending) if concurrent else None

        first = turns[0]
        room.update(round=first.round,
                    context_tokens=max(self.count(turn.member.model, self.prompt(turn, pending if index == 0 else (), history=history))
                                       for index, turn in enumerate(turns)),
                    next_speaker_id=turns[1].member.id if len(turns) > 1 else next_id)

        async def play_one(index, turn):
            if started is not None:
                started(index)
            interjections = list(pending) if index == 0 else []

            def make_prompt():
                if concurrent:
                    interjections.extend(room.take_pending())
                return self.prompt(turn, interjections, history=history)

            result = await self.call(turn, make_prompt, restart_on_interrupt=concurrent)
            if completed is not None:
                completed(index, result)
            return result

        if len(turns) == 1:
            results = [await play_one(0, first)]
        else:
            # Run model calls concurrently while awaiting their complete batch before the next phase.
            async with asyncio.TaskGroup() as group:
                tasks = [group.create_task(play_one(index, turn)) for index, turn in enumerate(turns)]
            results = [task.result() for task in tasks]
        if self.blocked_reason:
            self.check_budget()
        return results

    async def one(self, turn):
        return (await self.play([turn]))[0]


async def run_room(room, mode):
    flow = RoomFlow(room)
    try:
        if room.record["mode"] == "round":
            while True:
                await room.ready.wait()
                turn = room.next_turn(mode)
                if turn is None:
                    break
                await flow.play([turn], next_id=room.upcoming(mode, turn), mentions=False)
                mode.on_message_end(turn)
            await room.ready.wait()
            success = bool(flow.successful or not flow.failures)
        else:
            success = await mode.run(flow)
            await room.ready.wait()
    except BudgetStop as exc:
        room.add_message(None, "system", str(exc))
        status = "budget_exceeded"
    else:
        status = "finished" if success else "error"
    room.update(status=status, next_speaker_id=None, speaker_id=None)
