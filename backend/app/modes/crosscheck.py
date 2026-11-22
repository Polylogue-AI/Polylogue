import re

from .base import StructuredReply, Turn, json_reply, reply_text


def answer_label(index):
    label = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        label = chr(65 + remainder) + label
    return f"回答 {label}"


def review_parser(labels):
    def parse(text):
        reviews = json_reply(text).get("reviews")
        if not isinstance(reviews, dict) or reviews.keys() != set(labels):
            raise ValueError("必须逐个点评所有其他回答")
        lines = []
        for label in labels:
            entry = reviews[label]
            if not isinstance(entry, dict):
                raise ValueError("点评格式无效")
            score = entry.get("score")
            if type(score) is not int or not 0 <= score <= 10:
                raise ValueError("评分须为 0 到 10 的整数")
            lines.append(f"- **{label} · {score}/10**：{reply_text(entry.get('comment'))}")
        return StructuredReply("\n".join(lines))
    return parse


def read_verdict(text):
    value = json_reply(text)
    meta = {}
    for key in ("agreements", "disagreements"):
        entries = value.get(key)
        if not isinstance(entries, list):
            raise ValueError("需要列出共识和分歧")
        meta[key] = [reply_text(entry) for entry in entries]
    return StructuredReply(reply_text(value.get("conclusion")), meta)


class Crosscheck:
    def __init__(self, duties, _rounds):
        self.answerers = duties["answerer"]
        self.judge = duties["judge"][0]
        identities = {name for member in self.answerers for name in (member.name, member.model, member.id) if name}
        self.identities = re.compile("|".join(re.escape(name) for name in sorted(identities, key=len, reverse=True)), re.I)

    def anonymous(self, text):
        return self.identities.sub("[匿名]", text)

    async def run(self, flow):
        flow.mode_state(phase="answer")
        answers = await flow.play([
            Turn(member, 1, goal="独立回答主题，说明依据和不确定之处。不要署名。",
                 meta={"phase": "answer", "anon_label": answer_label(index)}, private_history=())
            for index, member in enumerate(self.answerers)
        ], concurrent=True)
        anonymous = [(index, answer_label(index), self.anonymous(answer.content))
                     for index, answer in enumerate(answers) if answer]
        if not anonymous:
            return False

        flow.mode_state(phase="review")
        reviews = []
        for index, member in enumerate(self.answerers):
            others = [("", label, answer) for author, label, answer in anonymous if author != index]
            if not others:
                continue
            review = await flow.one(Turn(
                member, 1, meta={"phase": "review"}, private_history=tuple(others),
                parse=review_parser([label for _, label, _ in others]),
                goal='逐个点评其他匿名回答。仅返回 JSON {"reviews":{"回答 A":{"score":8,"comment":"依据"}}}。'
                     "用实际给出的代号作为键，分数为 0 到 10 的整数。不要署名。",
            ))
            if review:
                reviews.append(("", f"互评 {len(reviews) + 1}", self.anonymous(review.content)))

        flow.mode_state(phase="verdict")
        result = await flow.one(Turn(
            self.judge, 1, "verdict", meta={"phase": "verdict"}, parse=read_verdict,
            private_history=tuple([("", label, answer) for _, label, answer in anonymous] + reviews),
            goal='综合匿名回答和互评，给出结论、共识与分歧。仅返回 JSON '
                 '{"conclusion":"建议","agreements":["共识"],"disagreements":["分歧"]}。',
        ))
        if result:
            flow.mode_state(phase="done")
        return bool(result)
