"""Sequential discussion and final summary."""

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from decimal import Decimal
from ..llm import LLM, Usage
from .base import Member, Turn, build_prompt


@dataclass(frozen=True)
class Speech:
    turn: Turn
    content: str
    usage: Usage


class ModelCallError(RuntimeError):
    def __init__(self, model: str, cause: Exception) -> None:
        self.model = model
        self.cause = cause
        super().__init__(f"{model}（{type(cause).__name__}）")


def total_cost(speeches: Sequence[Speech]) -> Decimal | None:
    costs = [speech.usage.cost_cny for speech in speeches]
    if any(cost is None for cost in costs):
        return None
    return sum((cost for cost in costs if cost is not None), Decimal(0))


class Roundtable:
    def __init__(
        self, members: Sequence[Member], rounds: int, *, summarizer_id: str | None = None,
        first_round: int = 1,
    ) -> None:
        if len(members) < 2 or len({member.id for member in members}) != len(members):
            raise ValueError("圆桌需要至少两位成员，成员 ID 不得重复")
        if not 1 <= rounds <= 6:
            raise ValueError("轮数必须介于 1 和 6")
        if any(member.max_chars is not None and member.max_chars < 1 for member in members):
            raise ValueError("发言字数上限必须大于零")
        self.members = tuple(members)
        self.rounds = rounds
        self.first_round = first_round
        self.position = 0
        self.summarizer = next(
            (member for member in self.members if member.id == summarizer_id), None,
        ) if summarizer_id is not None else self.members[-1]
        if self.summarizer is None:
            raise ValueError("汇总者必须是圆桌成员")

    def next_speaker(self, mention: str | None = None) -> Turn | None:
        round_index, seat = divmod(self.position, len(self.members))
        if round_index < self.rounds:
            scheduled = Turn(self.members[seat], self.first_round + round_index, "chat")
        elif self.position == self.rounds * len(self.members):
            scheduled = Turn(self.summarizer, self.first_round + self.rounds - 1, "summary")
        else:
            scheduled = None
        if mention:
            member = next((member for member in self.members if member.id == mention), None)
            if member is not None:
                number = scheduled.round if scheduled else self.first_round + self.rounds - 1
                return Turn(member, number, "chat")
        return scheduled

    build_prompt = staticmethod(build_prompt)

    def on_message_end(self, turn: Turn) -> None:
        if turn == self.next_speaker():
            self.position += 1

    async def discuss(self, topic: str, llm: LLM) -> AsyncIterator[Speech]:
        from ..orchestrator import discuss

        mode = Roundtable(self.members, self.rounds, summarizer_id=self.summarizer.id,
                          first_round=self.first_round)
        async for speech in discuss(mode, topic, llm):
            yield speech
