import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from ..context import build_context


@dataclass(frozen=True)
class Member:
    id: str
    name: str
    model: str
    role: str
    system_prompt: str
    temperature: float = 0.5
    max_chars: int | None = 300
    can_run_code: bool = False


@dataclass(frozen=True)
class StructuredReply:
    content: str
    meta: dict = field(default_factory=dict)
    data: object = None
    runs: tuple[tuple[str, str, str], ...] = ()


@dataclass(frozen=True)
class Turn:
    member: Member
    round: int
    kind: Literal["chat", "summary", "verdict"] = "chat"
    goal: str = ""
    meta: dict = field(default_factory=dict)
    parse: Callable[[str], StructuredReply] | None = None
    private_history: tuple[tuple[str, str, str], ...] | None = None
    system_prompt_override: str | None = None
    allow_tools: bool = False

    @property
    def system_prompt(self) -> str:
        return self.system_prompt_override or f"你是{self.member.name}，角色是{self.member.role}。\n{self.member.system_prompt}"

    @property
    def instruction(self) -> str:
        goal = self.goal or (
            "汇总讨论，清楚列出建议、共识、分歧和下一步。"
            if self.kind == "summary"
            else f"这是第 {self.round} 轮。结合已有讨论给出你的观点。"
        )
        if self.parse is not None:
            return goal
        limit = f"发言不超过 {self.member.max_chars} 字。" if self.member.max_chars else ""
        return f"{goal}{limit}\n至少指出一个前面没人提到的问题或补充。"


def build_prompt(turn, topic, history, *, pending=(), directions=(), summary=""):
    system_prompt = turn.system_prompt
    if directions:
        system_prompt += "\n方向指示：\n" + "\n".join(directions)
    if turn.private_history is not None:
        history, summary = turn.private_history, ""
    return build_context(
        topic=topic, system_prompt=system_prompt, instruction=turn.instruction,
        speaker_id=turn.member.id, speaker_name=turn.member.name, history=history,
        pending=pending, summary=summary,
    )


def json_reply(text):
    text = text.strip()
    if match := re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL | re.IGNORECASE):
        text = match[1]
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("预期 JSON 对象")
    return value


def reply_text(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("结构化回复缺少正文")
    return value.strip()
