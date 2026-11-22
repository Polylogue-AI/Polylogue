"""Build prompts and estimate context size for each room turn."""

from collections.abc import Iterable
import re

from .llm import ChatMessage


def build_context(
    *, topic: str, system_prompt: str, instruction: str, speaker_id: str, speaker_name: str,
    history: Iterable[tuple[str, str, str]],
    pending: Iterable[str] = (),
    summary: str = "",
) -> list[ChatMessage]:
    messages: list[ChatMessage] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"[讨论主题]：{topic}"},
    ]
    if summary:
        messages.append({"role": "user", "content": f"[早期讨论摘要]：{summary}"})
    messages.extend(
        {"role": "assistant" if author_id == speaker_id else "user",
         "content": f"[{label}]：{text}"}
        for author_id, label, text in history
    )
    request = f"现在轮到你（{speaker_name}），本轮要求：{instruction}"
    interjections = "\n".join(pending)
    if interjections:
        request += f"\n以下是人类刚刚的插话，请先回应：\n{interjections}"
    messages.append({"role": "user", "content": request})
    return messages


def estimate_tokens(messages):
    total = 0
    for message in messages:
        text = message["content"]
        wide = len(re.findall(r"[^\x00-\x7f]", text))
        total += 4 + (len(text) - wide + 3) // 4 + (3 * wide + 1) // 2
    return total


def compression_prompt(topic, previous, history):
    inputs = "\n\n".join(f"[{label}]：{text}" for _, label, text in history)
    return [
        {"role": "system", "content": "压缩早期讨论，保留主要事实、证据、决策、分歧和待办。用中文输出简短摘要。"},
        {"role": "user", "content": f"主题：{topic}\n已有摘要：{previous}\n请合并以下轮次，仅输出更新后的摘要。\n{inputs}"},
    ]
