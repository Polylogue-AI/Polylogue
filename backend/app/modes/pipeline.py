from ..db import new_id
from .base import StructuredReply, Turn, json_reply, reply_text

MAX_TASKS = 5


def read_plan(text):
    tasks = json_reply(text).get("tasks")
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= MAX_TASKS:
        raise ValueError(f"任务列表必须有 1 到 {MAX_TASKS} 项")
    titles = [reply_text(title) for title in tasks]
    if len({title.casefold() for title in titles}) != len(titles):
        raise ValueError("任务标题不得重复")
    return StructuredReply("### 任务计划\n" + "\n".join(f"- {title}" for title in titles), data=titles)


def read_verdict(text):
    value = json_reply(text)
    verdict = value.get("verdict")
    if verdict not in ("approved", "needs_fix"):
        raise ValueError("审查结论无效")
    return StructuredReply(reply_text(value.get("comment")), {"verdict": verdict}, verdict)


class Pipeline:
    def __init__(self, duties, rounds):
        self.planner = duties["planner"][0]
        self.executors = duties["executor"]
        self.reviewer = duties.get("reviewer", [self.planner])[0]
        self.rounds = rounds
        self.tasks = []

    def publish(self, flow):
        flow.mode_state(tasks=[dict(task) for task in self.tasks])

    def new_task(self, stage, title, assignee, status="queued"):
        task = dict(id=new_id("t"), stage=stage, title=title, assignee_id=assignee.id,
                    status=status, rework_count=0)
        self.tasks.append(task)
        return task

    async def run(self, flow):
        planner = self.planner
        plan = self.new_task("plan", "拆分任务", planner, "running")
        self.publish(flow)
        planned = await flow.one(Turn(
            planner, 1, goal='输出任务列表。仅返回 JSON {"tasks":["任务标题"]}。'
                             f'通常拆成 2 到 {MAX_TASKS} 项具体、不重复的任务，简单主题可用 1 项。'
                             f'合并细碎或重叠的工作，最多 {MAX_TASKS} 项。',
            meta={"task_id": plan["id"]}, parse=read_plan,
        ))
        plan["status"] = "done" if planned else "needs_fix"
        self.publish(flow)
        if not planned:
            return False

        plan_history = (("pipeline_plan", "任务计划", planned.content),)
        work = []
        for index, title in enumerate(planned.data):
            executor = self.executors[index % len(self.executors)]
            work.append((self.new_task("exec", title, executor), executor))
        self.publish(flow)

        def execute(task, executor, history=plan_history):
            return Turn(executor, max(1, task["rework_count"]), meta={"task_id": task["id"]},
                        goal=f"完成这项任务：{task['title']}。有审查退回意见时，修正其中指出的问题。直接提交可用的结果。",
                        private_history=history)

        def completed(index, output):
            task, _ = work[index]
            task.update(stage="review" if output else "exec", status="queued" if output else "needs_fix")
            self.publish(flow)

        def started(index):
            work[index][0]["status"] = "running"
            self.publish(flow)

        drafts = await flow.play([execute(task, member) for task, member in work],
                                 concurrent=True, started=started, completed=completed)
        findings = []
        for (task, executor), draft in zip(work, drafts):
            task_history = list(plan_history)
            while draft:
                current_draft = (executor.id, "待审稿件", draft.content)
                task_history.append(current_draft)
                task.update(stage="review", status="running")
                self.publish(flow)
                review = await flow.one(Turn(
                    self.reviewer, max(1, task["rework_count"]), meta={"task_id": task["id"]}, parse=read_verdict,
                    private_history=(*plan_history, current_draft),
                    system_prompt_override=f"你是{self.reviewer.name}，本轮担任流水线审查者。",
                    goal='给出审查结论。仅返回 JSON {"verdict":"approved 或 needs_fix","comment":"审查意见"}。'
                         "只有任务未完成、存在事实错误或方案无法执行时，才给 needs_fix 并写明原因。"
                         "可以改进的细节写在 comment 中，结论给 approved。"
                         f"\n任务：{task['title']}。请审查当前待审稿件。",
                ))
                if review and review.data == "approved":
                    task.update(stage="merge", status="done")
                    break
                task["status"] = "needs_fix"
                self.publish(flow)
                if not review or task["rework_count"] >= self.rounds:
                    break
                task_history.append((self.reviewer.id, "审查退回意见", review.content))
                task.update(stage="exec", status="running", rework_count=task["rework_count"] + 1)
                self.publish(flow)
                draft = await flow.one(execute(task, executor, tuple(task_history)))
            if task["status"] == "running":
                task["status"] = "needs_fix"
            self.publish(flow)
            findings.append(f"{task['title']}（{'通过' if task['status'] == 'done' else '未通过'}）："
                            f"{draft.content if draft else '无可用稿件'}")
        merge = self.new_task("merge", "汇总结果", planner, "running")
        self.publish(flow)
        result = await flow.one(Turn(
            planner, max(1, *(task["rework_count"] for task, _ in work)), "summary",
            goal="合并通过审查的任务成果，统一表述。单独标出尚未通过的部分。\n" + "\n".join(findings),
            meta={"task_id": merge["id"]}, private_history=(),
        ))
        merge["status"] = "done" if result else "needs_fix"
        self.publish(flow)
        return bool(result)
