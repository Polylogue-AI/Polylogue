from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator


Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
Short = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2)]
Mode = Literal["round", "pipe", "cross", "debate"]
Duty = Literal["speaker", "summarizer", "planner", "executor", "reviewer", "answerer", "judge", "pro", "con"]
Cost = Annotated[Decimal, Field(ge=0, allow_inf_nan=False)]
Temperature = Annotated[float, Field(ge=0, le=1)]
MaxChars = Annotated[int, Field(gt=0)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Login(Input):
    invite_code: Text
    name: Text


class InviteInput(Input):
    note: str


class MemberInput(Input):
    name: Text
    short: Short
    color: Text
    model: Text
    role: str
    system_prompt: str
    temperature: Temperature
    max_chars: MaxChars | None
    monthly_budget_cny: Cost | None
    can_mention: bool
    can_run_code: bool = False


class MemberPatch(Input):
    name: Text | None = None
    short: Short | None = None
    color: Text | None = None
    model: Text | None = None
    role: str | None = None
    system_prompt: str | None = None
    temperature: Temperature | None = None
    max_chars: MaxChars | None = None
    monthly_budget_cny: Cost | None = None
    can_mention: bool | None = None
    can_run_code: bool | None = None

    @model_validator(mode="after")
    def check_nulls(self):
        for key in self.model_fields_set - {"max_chars", "monthly_budget_cny"}:
            if getattr(self, key) is None:
                raise ValueError(f"{key} 不能为空")
        return self


class RoomInput(Input):
    topic: Text
    title: str | None = None
    mode: Mode
    ai_member_ids: list[Text]
    human_user_ids: list[Text]
    duties: dict[str, Duty] = Field(default_factory=dict)
    rounds: Annotated[int, Field(ge=1, le=6)]
    budget_cny: Cost
    auto_start: bool


class Hello(Input):
    type: Literal["hello"]
    last_seq: Annotated[int, Field(ge=0, strict=True)]


class Say(Input):
    type: Literal["say"]
    content: Annotated[str, Field(min_length=1)]
    mentions: list[Text]
    client_id: str


class Steer(Input):
    type: Literal["steer"]
    content: Annotated[str, Field(min_length=1)]


class RunFile(Input):
    path: str
    content: str


class RunInput(Input):
    language: Literal["python", "node", "html"]
    files: list[RunFile]
    test: str | None = None

    @field_validator("test")
    @classmethod
    def omit_blank_test(cls, test):
        return test if test and test.strip() else None


class RunEvent(RunInput):
    type: Literal["run"]
    reply_to: str | None = None


class Action(Input):
    type: Literal["start", "pause", "resume", "interrupt", "skip"]
