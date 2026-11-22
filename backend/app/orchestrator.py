import asyncio
from contextlib import aclosing
from dataclasses import dataclass, field
from math import ceil

from .llm import Usage
from .modes.roundtable import ModelCallError, Speech


@dataclass
class Output:
    parts: list[str] = field(default_factory=list)
    usage: Usage | None = None

    @property
    def content(self):
        return "".join(self.parts)


async def stream_turn(llm, turn, prompt, output, on_delta=None):
    member = turn.member
    max_tokens = None if member.max_chars is None else ceil(member.max_chars * 1.5)
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


async def run_room(room, mode):
    successful = 0
    failures = 0
    while True:
        await room.ready.wait()
        if room.peek_turn(mode) is None:
            room.update(status="error" if failures and not successful else "finished",
                        next_speaker_id=None, speaker_id=None)
            return
        reason = room.budget_reason()
        if reason:
            room.add_message(None, "system", reason)
            room.update(status="budget_exceeded", next_speaker_id=None, speaker_id=None)
            return
        turn = room.next_turn(mode)
        pending = room.take_pending()
        prompt = mode.build_prompt(turn, room.record["topic"], room.history(key for key, _ in pending),
                                   pending=(text for _, text in pending), directions=room.directions())
        room.update(round=turn.round, speaker_id=turn.member.id,
                    context_tokens=sum(len(message["content"]) for message in prompt),
                    next_speaker_id=room.upcoming(mode, turn))
        for attempt in range(2):
            if attempt and (reason := room.budget_reason()):
                room.add_message(None, "system", reason)
                room.update(status="budget_exceeded", next_speaker_id=None, speaker_id=None)
                return
            output = Output()
            message = room.begin_message(turn)
            task = asyncio.create_task(stream_turn(
                room.llm, turn, prompt, output, lambda delta: room.delta(message, delta),
            ))
            room.current_task = task
            try:
                await task
            except asyncio.CancelledError:
                room.end_message(message, output, interrupted=True)
                if asyncio.current_task().cancelling() or not room.cancel_current:
                    raise
                break
            except Exception:
                room.end_message(message, output)
                if room.cancel_current:
                    break
                if attempt == 1:
                    failures += 1
                    room.add_message(None, "system", f"{turn.member.name} 调用失败，已跳过")
            else:
                room.end_message(message, output)
                successful += 1
                break
            finally:
                room.current_task = None
                room.cancel_current = False
        mode.on_message_end(turn)
        next_turn = room.peek_turn(mode)
        room.update(speaker_id=None, next_speaker_id=next_turn.member.id if next_turn else None,
                    status="running" if room.ready.is_set() else "paused")
