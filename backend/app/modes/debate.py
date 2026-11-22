from .base import StructuredReply, Turn, json_reply, reply_text


def read_score(text):
    value = json_reply(text)
    score = value.get("score_pro")
    if type(score) is not int or not 0 <= score <= 100:
        raise ValueError("正方倾向分须为 0 到 100 的整数")
    return StructuredReply(reply_text(value.get("comment")), data=score)


class Debate:
    def __init__(self, duties, rounds):
        self.pro = duties["pro"]
        self.con = duties["con"]
        self.judge = duties["judge"][0]
        self.rounds = rounds

    async def run(self, flow):
        for number in range(1, self.rounds + 1):
            await flow.one(Turn(
                self.pro[(number - 1) % len(self.pro)], number, meta={"side": "pro"},
                goal=f"第 {number} 轮正方陈词，提出理由并回应反方已有论点。",
            ))
            await flow.one(Turn(
                self.con[(number - 1) % len(self.con)], number, meta={"side": "con"},
                goal=f"第 {number} 轮反方陈词，提出理由并回应正方论点。",
            ))
            score = await flow.one(Turn(
                self.judge, number, meta={"side": "judge"}, parse=read_score,
                goal=f'点评第 {number} 轮并给出 0 到 100 的正方倾向分。仅返回 JSON '
                     '{"score_pro":50,"comment":"简短点评"}。',
            ))
            if score:
                flow.mode_state(score_pro=score.data)
        result = await flow.one(Turn(
            self.judge, self.rounds, "verdict", meta={"side": "judge"},
            goal="给出最终裁决。说明关键论点、胜负依据以及仍有分歧之处。",
        ))
        return bool(result)
