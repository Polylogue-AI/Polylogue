from decimal import Decimal

import pytest

from app.llm import FakeLLM
from app.modes.roundtable import Member, Roundtable, total_cost


@pytest.fixture
def members():
    return [
        Member("ai_a", "甲", "vendor_a/model", "设计", "提出方案。"),
        Member("ai_b", "乙", "vendor_b/model", "评估", "检查可行性。"),
        Member("ai_c", "丙", "vendor_c/model", "汇总", "指出风险。"),
    ]


@pytest.mark.asyncio
async def test_two_rounds_and_summary(members):
    llm = FakeLLM(cost_cny=Decimal("0.0007"))
    speeches = [speech async for speech in Roundtable(members, 2).discuss("如何分工？", llm)]

    assert [speech.turn.member.id for speech in speeches] == [
        "ai_a", "ai_b", "ai_c", "ai_a", "ai_b", "ai_c", "ai_c",
    ]
    assert [speech.turn.round for speech in speeches] == [1, 1, 1, 2, 2, 2, 2]
    assert [speech.turn.kind for speech in speeches] == ["chat"] * 6 + ["summary"]
    assert all(speech.content and speech.usage.tokens_out > 0 for speech in speeches)
    assert total_cost(speeches) == Decimal("0.0049")


@pytest.mark.asyncio
async def test_history_and_explicit_summarizer(members):
    class RecordingLLM(FakeLLM):
        def __init__(self):
            super().__init__({member.model: member.name for member in members})
            self.prompts = []

        async def stream_chat(self, model, messages, temperature, max_tokens):
            self.prompts.append((messages, max_tokens))
            return await super().stream_chat(model, messages, temperature, max_tokens)

    llm = RecordingLLM()
    table = Roundtable(members, 1, summarizer_id="ai_a")
    speeches = [speech async for speech in table.discuss("如何分工？", llm)]
    assert [speech.turn.member.id for speech in speeches] == ["ai_a", "ai_b", "ai_c", "ai_a"]
    prompt, max_tokens = llm.prompts[-1]
    assert prompt[0]["role"] == "system"
    assert prompt[0]["content"] == "你是甲，角色是设计。\n提出方案。"
    assert prompt[1] == {"role": "user", "content": "[讨论主题]：如何分工？"}
    assert prompt[2:-1] == [
        {"role": "assistant", "content": "[甲（设计）]：甲"},
        {"role": "user", "content": "[乙（评估）]：乙"},
        {"role": "user", "content": "[丙（汇总）]：丙"},
    ]
    assert prompt[-1]["role"] == "user"
    assert "现在轮到你（甲），本轮要求：汇总讨论" in prompt[-1]["content"]
    assert max_tokens == 450


@pytest.mark.asyncio
async def test_default_summarizer_receives_user_instruction_after_own_speech(members):
    reply = "文" * 300 + "。"

    class RecordingLLM(FakeLLM):
        async def stream_chat(self, model, messages, temperature, max_tokens):
            self.last_prompt = messages
            return await super().stream_chat(model, messages, temperature, max_tokens)

    llm = RecordingLLM({members[-1].model: reply})
    speeches = [speech async for speech in Roundtable(members, 2).discuss("如何分工？", llm)]

    assert speeches[-2].content == reply
    assert llm.last_prompt[-2] == {"role": "assistant", "content": f"[丙（汇总）]：{reply}"}
    assert llm.last_prompt[-1]["role"] == "user"
    assert "现在轮到你（丙），本轮要求：汇总讨论" in llm.last_prompt[-1]["content"]


@pytest.mark.asyncio
async def test_fake_stream_yields_characters_and_reports_partial_usage():
    llm = FakeLLM({"fake": "你好"})
    stream = await llm.stream_chat("fake", [{"role": "user", "content": "问题"}], 0.5, None)
    assert await anext(stream) == "你"
    await stream.aclose()
    assert stream.usage is not None
    assert (stream.usage.tokens_in, stream.usage.tokens_out) == (2, 1)
