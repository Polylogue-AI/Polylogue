# 给 ChatGPT 的任务书：AI Roundtable 后端

> 使用方法：把本文件和《03-接口契约.md》一起发给 ChatGPT。

---

你好。我们在做一个私用的多人多模型协作平台 **AI Roundtable**：2–10 个朋友和多个 AI 模型坐在同一个"房间"里，用圆桌讨论、分工流水线、交叉验证、辩论四种方式一起完成任务，人可以随时插话、@ 某个模型、暂停或打断。

分工如下：
- **你负责整个后端**，放在 `backend/` 目录。
- Claude 负责前端，已经写好，自带一个模拟后端，正在用模拟数据运行。
- 前后端之间唯一的约定是附带的《接口契约》。**请严格按契约实现，字段名、事件名、状态值一个都不要改**。觉得契约有问题，请先提出来，不要直接改。
- 你交付的代码会由 Claude 运行测试并审查，审查意见会转给你。前端代码也会发给你审查。

## 1. 技术约束

| 项目 | 要求 |
|---|---|
| 语言 | Python 3.12+ |
| Web 框架 | FastAPI，WebSocket 用 FastAPI 自带的 |
| 模型接入 | LiteLLM SDK（`litellm.acompletion(stream=True)`、`litellm.completion_cost()`）。**不要用** LiteLLM Proxy，**不要用**带企业许可标注的功能 |
| 编排 | **自己写**状态机，不要依赖 AutoGen、LangGraph、Microsoft Agent Framework、CrewAI |
| 存储 | SQLite。用 SQLAlchemy 2.x 或 `aiosqlite` 均可 |
| 配置 | `.env`，提供 `.env.example`。API Key 只存在服务器端，任何接口都不能返回完整 Key |
| 测试 | pytest + pytest-asyncio。**测试里不能调用真实模型**：把 `llm.py` 设计成可替换的，测试用假模型 |
| 依赖管理 | `pyproject.toml`（推荐 uv）或 `requirements.txt` |
| 许可 | 不复制 LLM Council 的代码（它没有许可证），可以参考它"各自回答 → 匿名互评 → 主席汇总"的思路 |

## 2. 目录结构

```
backend/
├── app/
│   ├── main.py            # FastAPI 入口，挂载 REST 路由和 WebSocket
│   ├── config.py          # 读 .env
│   ├── auth.py            # 邀请码登录、会话 Cookie
│   ├── db.py              # 表结构和数据访问
│   ├── llm.py             # LiteLLM 封装：流式、费用、重试、可替换
│   ├── room.py            # 房间运行时：连接管理、广播、消息队列
│   ├── orchestrator.py    # 编排循环：暂停、恢复、打断、跳过、预算检查
│   ├── context.py         # 给模型的上下文组装和压缩
│   ├── budget.py
│   ├── modes/
│   │   ├── base.py        # Mode 接口：next_speaker() / build_prompt() / on_message_end()
│   │   ├── roundtable.py
│   │   ├── pipeline.py
│   │   ├── crosscheck.py
│   │   └── debate.py
│   └── routers/           # auth.py, members.py, rooms.py, usage.py, ws.py
├── tests/
├── .env.example
└── pyproject.toml
```

可以调整内部文件划分，但 `llm.py` 必须独立、可替换。

## 3. 关键设计要求

1. **编排循环在两次发言之间检查状态**：暂停时 `await` 一个 `asyncio.Event`；打断和跳过通过取消当前的流式任务实现（`task.cancel()`），被取消时把已输出的部分以 `interrupted=True` 存库并发出 `message_end`。
2. **人的插话**：人的消息随时可以进来，进入房间的待处理队列。下一位 AI 构造上下文时，最后要附上"以下是人类刚刚的插话，请先回应"。被 @ 的 AI 插到下一位。
3. **上下文组装**：角色设定 + 方向指示（steer）+ 早期摘要 + 最近 N 条原文 + 待回应的插话。每条历史发言要带上说话人名字，例如 `[DeepSeek（唱反调）]：……`，因为 LiteLLM 的 messages 只有 user/assistant 两种角色。轮到某个 AI 时，它自己以前的发言用 `assistant`，其他人的用 `user`。
4. **防止互相附和**：每个 AI 的系统提示末尾追加"至少指出一个前面没人提到的问题或补充"。
5. **费用**：每次调用结束后用 `completion_cost()` 算美元，乘汇率换成人民币，记到消息、房间和房间创建人名下。被打断的调用按已产生的 tokens 估算。
6. **字数上限**：`max_chars` 写进提示词，同时用 `max_tokens` 兜底（中文约 1 字 ≈ 1.5 token）。
7. **广播**：一个房间一组连接，`message_delta` 可以攒 30–50ms 再推，减少消息数量。
8. **重连**：`hello.last_seq` 之后的消息从数据库补；正在输出的那条用内存里的已输出内容。

## 4. 本次要交付的内容（按顺序）

### 第一批：M1 原型

1. `llm.py`：
   - `async def stream_chat(model, messages, temperature, max_tokens) -> AsyncIterator[str]`，结束后能拿到 `tokens_in`、`tokens_out`、`cost_cny`
   - 一个 `FakeLLM` 实现，按固定文本逐字输出，供测试使用
2. `modes/roundtable.py` + 一个命令行脚本 `python -m app.cli "问题"`：3 个不同厂商的模型轮流讨论 2 轮，最后汇总，打印每条发言和总费用。
3. 测试：用 `FakeLLM` 跑通圆桌模式，断言发言顺序、轮数、汇总者最后发言、费用累加正确。

**验收标准**：命令行能跑；`pytest` 全部通过且不联网。

### 第二批：M2 可用

> 契约已更新到 **v0.2**，新增内容见契约末尾的变更记录。本批暂不接真实 API，全部开发和测试都用假模型。

**先修第一批的审查意见**（`docs/review/后端-2026-11-22.md`）：必修第 1 条，以及第 2、3 条；第 4 条只改报错信息和按实际模型检查 Key，模型名核对留到接真实 API 时。

1. 按审查意见第 5 条，把圆桌模式改成 `next_speaker()` / `build_prompt()` / `on_message_end()` 接口，编排循环放进 `orchestrator.py`。
2. **假模型模式**：`LLM_MODE=fake` 时，`uvicorn app.main:app --port 8000` 不需要任何 Key 就能启动。`FakeLLM` 要有逐字延迟（默认 30ms/字）和非零费用，回复内容带上发言者名字和轮次，例如"（Claude 第 2 轮）……"，方便在界面上分辨。启动时如果数据库是空的，自动建好一个管理员和契约示例里的几个 AI 成员。
3. 提示词规则（来自第一批审查，后续所有模式都适用）：发给模型的 messages **最后一条必须是 `user`**，写明"现在轮到你（名字），本轮要求：……"；不截断模型输出。
4. 数据库表、邀请码登录、契约第 2 节的全部 REST 接口，包括新增的 `/api/invites`。
5. WebSocket 房间：契约第 3 节的全部事件；暂停、恢复、打断、跳过、插话、@。
6. 预算检查（房间上限、个人每月上限）；模型调用失败重试 1 次。
7. 测试：用 FastAPI 的 `TestClient` 连 WebSocket，配合 `FakeLLM` 测试以下场景：
   - 两个客户端连同一房间，都收到同样的 `message_delta`
   - AI 输出途中发 `interrupt`，收到 `message_end.interrupted == true`，`state.status == 'paused'`
   - 发 `say` 并 @ 某个 AI，下一个 `message_start` 的作者就是它
   - AI 输出途中发 `say`，下一位 AI 的 messages 最后一条 `user` 消息里包含这条插话
   - 断开后带 `last_seq` 重连，`snapshot` 只包含之后的消息
   - 预算设为 0.0001 元，第一次发言后状态变为 `budget_exceeded`
   - 默认汇总者（最后一位）汇总时，messages 最后一条的 role 是 `user`
   - 某个模型第一次调用抛异常、第二次成功：讨论正常继续；两次都失败：出现 system 消息并轮到下一位
   - 非管理员调用 `POST /api/members`、`POST /api/invites` 返回 `403`

**验收标准**：`pytest` 全部通过且不联网。`LLM_MODE=fake` 启动后端，前端关掉模拟模式（`VITE_MOCK=0`），Claude 会用两个浏览器窗口自动测试：登录、建房、两人同时看到逐字输出、插话、@、暂停、打断、跳过、断线重连。

### 第三批：M3 协作

8. `pipeline.py`：规划者输出 JSON 任务列表 → 执行者并发完成各自任务 → 审查者逐个审查，结论写进 `meta.verdict`，不通过则退回执行者（最多 `rounds` 次）→ 规划者汇总。全过程更新 `mode_state.tasks`。
9. `crosscheck.py`：所有 answerer **并发**回答（`phase: 'answer'`）→ 每个 answerer 对其他人的匿名回答（"回答 A/B/C"）打分点评（`phase: 'review'`）→ judge 汇总，输出结论，同时用结构化输出给出 `meta.agreements` 和 `meta.disagreements`（`kind: 'verdict'`）。
10. `debate.py`：正反方交替发言 `rounds` 回合；每回合结束后 judge 发一条简短点评，并更新 `mode_state.score_pro`；最后 judge 给出 `kind: 'verdict'` 的结论。
11. `context.py` 的压缩：上下文超过 20k tokens 时，用最便宜的可用模型把最早一轮压缩成摘要，更新 `state.summarized_until_round`。
12. `steer` 事件。

## 5. 交付格式

- 每个文件给出**完整内容**，开头注明路径，例如 `# backend/app/llm.py`。不要只给 diff 或片段。
- 每批结束时附一段说明：完成了什么、怎么运行、怎么跑测试、和契约有没有不一致的地方、有哪些已知问题。
- 遇到契约没写清楚的地方，可以先看前端模拟后端 `frontend/src/api/mock.ts` 的做法；还不清楚就列出问题，由项目负责人决定。

请先确认你理解了任务，并列出你对契约的疑问（如果有），然后开始第一批。
