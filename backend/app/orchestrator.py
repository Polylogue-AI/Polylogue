import asyncio
import json
import logging
from collections import defaultdict
from contextlib import aclosing
from dataclasses import dataclass, field, replace

from .context import compression_prompt, estimate_tokens
from .llm import Usage, model_error_detail, supports_tools
from .modes.base import StructuredReply, Turn, build_prompt
from .modes.roundtable import ModelCallError, Speech
from .sandbox import TOOL, result as run_result
from .schemas import RunInput

logger = logging.getLogger(__name__)

SPEECH_TOKEN_LIMIT = 4000
STRUCTURED_TOKEN_LIMIT = 8000


@dataclass
class Output:
    parts: list[str] = field(default_factory=list)
    usage: Usage | None = None
    truncated: bool = False
    tool_calls: list[dict] = field(default_factory=list)

    @property
    def content(self):
        return "".join(self.parts)


async def stream_turn(llm, turn, prompt, output, on_delta=None, *, max_tokens=None, tools=None):
    member = turn.member
    if max_tokens is None:
        max_tokens = STRUCTURED_TOKEN_LIMIT if turn.parse is not None else SPEECH_TOKEN_LIMIT
    options = {"tools": tools} if tools else {}
    stream = await llm.stream_chat(member.model, prompt, member.temperature, max_tokens, **options)
    labels = (member.name, f"{member.name}（{member.role}）", f"{member.name} ({member.role})")
    prefixes = tuple(f"[{label}]{colon}" for label in labels for colon in ("：", ":")) if turn.parse is None else ()
    pending = ""
    after_prefix = False

    leading = ""

    def emit(delta):
        nonlocal leading
        if not output.parts and not delta.strip():
            leading += delta
            return
        if delta:
            delta, leading = leading + delta, ""
            output.parts.append(delta)
            if on_delta:
                on_delta(delta)

    try:
        async with aclosing(stream):
            async for delta in stream:
                if prefixes:
                    pending += delta
                    text = pending.lstrip()
                    matched = next((prefix for prefix in prefixes if text.startswith(prefix)), None)
                    if matched is not None:
                        delta = text[len(matched):]
                        after_prefix = True
                    elif len(pending) <= max(128, max(map(len, prefixes))) and any(
                        prefix.startswith(text) for prefix in prefixes
                    ):
                        continue
                    else:
                        delta = pending
                    prefixes, pending = (), ""
                if after_prefix:
                    delta = delta.lstrip()
                    after_prefix = not delta
                emit(delta)
    finally:
        output.usage = stream.usage
        output.truncated = stream.truncated
        output.tool_calls = stream.tool_calls
        emit(pending)
    if output.truncated:
        logger.warning("模型 %s 达到输出上限（%s tokens），发言可能不完整。", member.model, max_tokens)
    if not output.content.strip() and not output.tool_calls:
        raise RuntimeError("模型流式响应缺少正文和工具调用")
    if output.usage is None:
        logger.warning("模型 %s 的流式响应缺少用量数据，按已有响应估算。", member.model)
        estimator = getattr(llm, "estimate_usage", None)
        if estimator is not None:
            try:
                output.usage = await asyncio.to_thread(
                    estimator, member.model, prompt, output.content, output.tool_calls, tools,
                )
            except Exception:
                logger.warning("模型 %s 的用量估算失败，改用文本长度估算。", member.model)
        if output.usage is None:
            text = output.content + (json.dumps(output.tool_calls, ensure_ascii=False) if output.tool_calls else "")
            output.usage = Usage(estimate_tokens(prompt), estimate_tokens([{"content": text}]), None)


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


class FollowupFailed(Exception):
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
        if turn.private_history is not None:
            history = (*turn.private_history, *room.history(human_runs_only=True))
            turn = replace(turn, private_history=history)
            summary = ""
        else:
            summary = room.context_summary()
        if history is None:
            history = room.history(key for key, _ in pending)
        return build_prompt(
            turn, room.record["topic"], history,
            pending=[text for _, text in pending], directions=room.directions(), summary=summary,
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
            result = await self.call(Turn(member, number), messages, visible=False)
            if self.blocked_reason:
                self.check_budget()
            if result is None:
                return
            room.update(summary=result.content, summarized_until_round=number)

    async def allows_tools(self, turn):
        room = self.room
        if (not room.sandbox or not room.sandbox.enabled or turn.parse is not None or turn.kind != "chat"
                or not (turn.allow_tools or room.record["mode"] == "round") or not turn.member.can_run_code):
            return False
        await room.sandbox.refresh()
        return room.sandbox.available and await asyncio.to_thread(
            supports_tools, room.llm, turn.member.model, room.tool_models,
        )

    async def tool_turn(self, turn, prompt, max_tokens):
        room = self.room
        member = turn.member
        sandbox = room.sandbox
        prompt[0]["content"] += (
            "\n你可以用 run_code 运行 Python、Node.js 或 HTML。运行环境没有网络，不能安装依赖，"
            f"单次限时 {sandbox.timeout} 秒。写完代码先运行验证，再给出结论；不要编造运行结果。"
        )
        runs = []
        texts = []
        used = 0
        while True:
            final = used >= sandbox.turn_limit
            if final:
                prompt.append({"role": "user", "content": "运行次数已用完，请根据已有结果给出最终回答。"})
            tools = [TOOL] if not final and sandbox.available else None
            if not final and tools is None:
                prompt.append({"role": "user", "content": f"运行环境不可用：{sandbox.reason}。请用文字回答。"})
            for attempt in range(2 if used else 1):
                self.check_budget()
                message = None
                output = Output()

                def emit(delta):
                    nonlocal message
                    if message is None:
                        message = room.begin_message(turn)
                    room.delta(message, delta)

                try:
                    await stream_turn(room.llm, turn, prompt, output, emit, max_tokens=max_tokens, tools=tools)
                except asyncio.CancelledError:
                    room.end_message(member.id, message, output, interrupted=True)
                    raise
                except Exception as exc:
                    room.end_message(member.id, message, output, interrupted=True)
                    if not used:
                        raise
                    if attempt == 1:
                        raise FollowupFailed(model_error_detail(exc)) from exc
                else:
                    break

            if message is not None or not output.tool_calls:
                room.end_message(member.id, message, output, interrupted=output.truncated)
            if output.content:
                texts.append(output.content)
            if not output.tool_calls:
                return StructuredReply("\n\n".join(texts), runs=tuple(runs))

            transcript = {"role": "assistant", "content": output.content, "tool_calls": []}
            prompt.append(transcript)
            charge = output.usage if message is None else None
            try:
                for call in output.tool_calls:
                    function = call["function"]
                    try:
                        args = json.loads(function["arguments"])
                        if not isinstance(args, dict):
                            raise ValueError
                    except (ValueError, TypeError, RecursionError):
                        args = None
                    transcript["tool_calls"].append(dict(call, function={
                        "name": function["name"] or "run_code",
                        "arguments": function["arguments"] if args is not None else "{}",
                    }))
                    if used >= sandbox.turn_limit:
                        outcome = run_result("error", stderr="运行次数已用完")
                    else:
                        used += 1
                        if function["name"] != "run_code" or args is None:
                            outcome = run_result("error", stderr="run_code 参数不是有效的 JSON 对象或工具名无效")
                        else:
                            try:
                                request = RunInput.model_validate(args)
                            except ValueError:
                                outcome = run_result("error", stderr="run_code 参数无效，请检查 language、files 和 test")
                            else:
                                usage, charge = charge, None
                                outcome, content = await room.run_code(member.id, request, turn=turn, usage=usage)
                                runs.append(("", f"{member.name} 运行了代码", content))
                    prompt.append({"role": "tool", "tool_call_id": call["id"],
                                   "content": json.dumps({key: value for key, value in outcome.items()
                                                          if key != "truncated"}, ensure_ascii=False)})
            finally:
                if charge is not None:
                    room.end_message(member.id, None, Output(usage=charge))

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

            prompt = make_prompt()

            async def model_turn():
                if visible and await self.allows_tools(turn):
                    return await self.tool_turn(turn, prompt, max_tokens)
                await stream_turn(
                    room.llm, turn, prompt, output, emit if visible and turn.parse is None else None,
                    max_tokens=max_tokens,
                )
                return None

            task = asyncio.create_task(model_turn())
            room.track(task, member_id if visible else None)
            try:
                reply = await task
                result = reply if reply is not None else (turn.parse(output.content) if turn.parse else StructuredReply(output.content))
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
            except BudgetStop as exc:
                self.blocked_reason = str(exc)
                return None
            except Exception as exc:
                room.end_message(member_id, message, output, interrupted=True)
                failures = 2 if isinstance(exc, FollowupFailed) else failures + 1
                logger.warning(
                    "房间 %s 成员 %s 模型 %s 任务 %s 第 %s 次调用失败（%s）：%s",
                    room.id, member_id, turn.member.model, turn.meta.get("task_id", "-"), failures,
                    type(exc).__name__, " ".join(model_error_detail(exc).splitlines()),
                )
                if failures == 2 and visible:
                    self.failures += 1
                    room.add_message(None, "system", f"{turn.member.name} 调用失败，已跳过")
            else:
                if visible and turn.parse is not None:
                    output.parts = [result.content]
                    emit(result.content)
                room.end_message(member_id, message, output, interrupted=output.truncated, meta=result.meta)
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
        history = room.history(key for key, _ in pending) if concurrent and any(
            turn.private_history is None for turn in turns
        ) else None
        member_locks = defaultdict(asyncio.Lock)

        first = turns[0]
        room.update(round=first.round,
                    context_tokens=max(self.count(turn.member.model, self.prompt(turn, pending if index == 0 else (), history=history))
                                       for index, turn in enumerate(turns)),
                    next_speaker_id=turns[1].member.id if len(turns) > 1 else next_id)

        async def play_one(index, turn):
            interjections = list(pending) if index == 0 else []

            def make_prompt():
                if concurrent:
                    interjections.extend(room.take_pending())
                return self.prompt(turn, interjections, history=history)

            async with member_locks[turn.member.id]:
                await room.ready.wait()
                if started is not None:
                    started(index)
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
