"""Build prompts shared by roundtable turns."""

from collections.abc import Iterable

from .llm import ChatMessage


def build_context(
    *, topic: str, system_prompt: str, instruction: str, speaker_id: str, speaker_name: str,
    history: Iterable[tuple[str, str, str]],
    pending: Iterable[str] = (),
) -> list[ChatMessage]:
    messages: list[ChatMessage] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"[讨论主题]：{topic}"},
    ]
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
