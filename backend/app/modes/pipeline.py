from ..db import new_id
from .base import StructuredReply, Turn, json_reply, reply_text


def read_plan(text):
    tasks = json_reply(text).get("tasks")
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= 8:
        raise ValueError("任务列表必须有 1 到 8 项")
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
            planner, 1, goal='输出任务列表。仅返回 JSON {"tasks":["任务标题"]}，提供 1 到 8 项具体、不重复的任务。',
            meta={"task_id": plan["id"]}, parse=read_plan,
        ))
        plan["status"] = "done" if planned else "needs_fix"
        self.publish(flow)
        if not planned:
            return False

        work = []
        for index, title in enumerate(planned.data):
            executor = self.executors[index % len(self.executors)]
            work.append((self.new_task("exec", title, executor), executor))
        self.publish(flow)

        def execute(task, executor, feedback=""):
            return Turn(executor, max(1, task["rework_count"]), meta={"task_id": task["id"]},
                        goal=f"完成这项任务：{task['title']}。直接提交可用的结果。\n返工反馈：{feedback}")

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
            while draft:
                task.update(stage="review", status="running")
                self.publish(flow)
                review = await flow.one(Turn(
                    self.reviewer, max(1, task["rework_count"]), meta={"task_id": task["id"]}, parse=read_verdict,
                    goal='给出审查结论。仅返回 JSON {"verdict":"approved 或 needs_fix","comment":"审查意见"}。'
                         f"\n任务：{task['title']}\n待审稿件：{draft.content}",
                ))
                if review and review.data == "approved":
                    task.update(stage="merge", status="done")
                    break
                task["status"] = "needs_fix"
                self.publish(flow)
                if not review or task["rework_count"] >= self.rounds:
                    break
                task.update(stage="exec", status="running", rework_count=task["rework_count"] + 1)
                self.publish(flow)
                draft = await flow.one(execute(task, executor, review.content)) or None
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
            meta={"task_id": merge["id"]},
        ))
        merge["status"] = "done" if result else "needs_fix"
        self.publish(flow)
        return bool(result)
