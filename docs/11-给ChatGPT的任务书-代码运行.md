# 给 ChatGPT 的任务书：代码运行（契约 v0.6）

> 使用方法：把下面分隔线以下的内容整段发给 ChatGPT，同时附上 `docs/03-接口契约.md`（已更新到 v0.6，新增第 4 节）。

---

## 背景

项目负责人用流水线让模型写一个网页小游戏，模型如实回答"没有运行环境，无法测试"。平台里的模型只能读写文字，写出来的代码对不对，只能靠人复制出去自己试。

前端已经先做了一个"运行预览"：发言里的 HTML / JS 代码块可以在浏览器的沙箱 iframe 里运行，报错可以一键发回房间。但模型自己仍然不能运行代码、看不到结果。

这一批做服务器端的代码运行：模型在发言过程中通过工具调用 `run_code`，在 Docker 沙箱里运行 Python、Node.js 或网页（无头 Chromium），根据结果继续写。人也可以把房间里的代码交给服务器运行。项目负责人的电脑已装 Docker Desktop（WSL2 后端）。

**所有行为以契约 v0.6 第 4 节为准**，下面只列分工、实现建议和验收标准。契约有不清楚或做不到的地方，先提出来，不要自行改变行为。

## 0. 先做：`docs/10` 的可用状态修复

后端刚启动时 `/api/models` 把所有服务商都标为不可用。改动很小，先修，单独补测试。

## 1. 沙箱镜像

- 新建 `backend/sandbox/Dockerfile`，构建一个镜像（默认名 `roundtable-sandbox`），包含 Python 3.12 + pytest、Node.js 22、Playwright 及其 Chromium，以及 html 运行用的 Node 脚本（静态服务器、打开页面、收集控制台和页面异常、执行 `test`、按契约输出 JSON）。
- 镜像里创建一个非 root 用户，运行时用它。
- README 写明构建命令（例如 `docker build -t roundtable-sandbox backend/sandbox`）和镜像大概的大小。

## 2. 运行器

- 新模块（建议 `app/sandbox.py`），用 `asyncio.create_subprocess_exec` 调 `docker` 命令行，不要引入 Docker SDK 依赖。
- 隔离参数按契约 4.3，至少包括：`--rm --network none --read-only --tmpfs`（工作目录和 /tmp）、`--user`（非 root）、`--cap-drop ALL`、`--security-opt no-new-privileges`、`--memory`、`--cpus`、`--pids-limit`。
- 代码通过标准输入或挂载的临时目录传入都可以。如果用挂载：Windows 上 Docker Desktop 的路径转换要测过；运行结束必须删除临时目录。
- 超时和取消：要用 `docker kill` 杀掉容器，不能只杀本地的 `docker` 进程（那样容器会继续跑）。建议给每个容器起一个唯一的 `--name` 方便清理。后端启动时清理带本项目前缀的残留容器。
- 并发：全局信号量 `SANDBOX_MAX_PARALLEL`，排队时 run 消息的状态为 `queued`。
- `GET /api/sandbox`：启动时检测一次（`docker version` 和镜像是否存在），之后每次请求可以用缓存的结果，但沙箱运行失败、发现 Docker 不可用时要更新缓存。
- 新的 `.env` 配置项（写进 `.env.example` 和 README）：`SANDBOX_ENABLED`（默认 0）、`SANDBOX_IMAGE`、`SANDBOX_TIMEOUT`（默认 20，上限 60）、`SANDBOX_MAX_PARALLEL`（默认 2）、`SANDBOX_MAX_RUNS_PER_TURN`（默认 5）、`SANDBOX_MEMORY`（默认 512m）。

## 3. 工具调用循环

按契约 4.4 实现，要点：

- **只在允许的步骤提供工具**（契约 4.4 的表格），JSON 步骤一律不提供。
- **AI 的 chat 消息在收到第一段非空文字时才 `message_start`。** 这会改变现有的流式逻辑，注意 `speaker_id`、打断、并发阶段重启的现有测试要继续通过。
- **流式输出里的工具调用参数要拼完整再解析。** 各家通过 LiteLLM 返回的 tool call 分片格式不完全一样，请用真实模型分别验证 Anthropic、OpenAI、DeepSeek（第 7 节）。
- **工具参数解析失败、路径不合法时**，不要中断这次发言，作为工具结果返回错误说明，让模型自己修正。
- **运行次数达到上限后**，最后一次调用不提供工具，并在提示里说明原因。
- `supports_tools` 用 `litellm.supports_function_calling(model)` 判断；LiteLLM 不认识的模型按 `false` 处理，可以由 `EXTRA_MODELS` 之外的方式覆盖，你来提方案，比如沿用 `supports_temperature` 那样的显式规则表。
- 费用、预算、暂停、打断、跳过、上下文、提示词的规则见契约 4.4，每一条都要有测试。

## 4. 人发起的运行

按契约 4.5，新增 WebSocket 客户端事件 `run`。不改变发言顺序、不打断讨论；同一个人同时只能有一个运行。

## 5. 成员字段

`AiMember.can_run_code`：默认 `false`，只有管理员能改（沿用成员写接口的权限）。已有数据库要能平滑升级：老成员没有这个字段时按 `false` 处理。

## 6. 离线测试

- **`FakeSandbox`**：假模型模式和测试里用它代替 Docker，按代码内容返回预设结果，例如代码里含 `raise` 就返回退出码 1，含 `while True` 就模拟超时。
- **`FakeLLM` 支持工具调用**：能按脚本先输出一段文字，再调用 `run_code`，收到结果后再输出文字。
- 至少覆盖：
  - 一次发言内"文字 → 运行 → 文字"产生 3 条消息，顺序和 `seq` 正确。
  - 只有工具调用、没有文字时，不产生空的 chat 消息，费用记在 run 消息上。
  - 达到运行次数上限后，最后一次调用没有工具。
  - 运行中打断：容器被终止（`FakeSandbox` 记录收到了取消），run 消息为 `cancelled` + `interrupted`，`resume` 后整个调用重新开始。
  - 运行中 `pause`：等整个发言结束才暂停。
  - 沙箱不可用：模型收到"运行环境不可用"的工具结果，讨论继续。
  - 不允许的步骤（审查、裁判等）不提供工具。
  - `can_run_code = false`、模型不支持工具时都不提供工具。
  - 后续发言的上下文里有 run 消息的摘要，没有原始的工具调用消息。
  - 流水线审查者的 `private_history` 里有本任务的 run 消息。
  - 人发起的运行：消息正确；同一个人第二次运行返回 `run_busy`；未启用时返回 `sandbox_disabled`。
  - 文件路径含 `..`、以 `/` 开头、文件超过数量或大小限制时，不运行，返回错误。
- **真实 Docker 的集成测试**：用 pytest 标记（例如 `@pytest.mark.docker`）默认跳过，有 Docker 时手动运行。覆盖：
  - 三种语言各跑通一次。
  - 超时后容器确实被删除（运行后 `docker ps -a` 里没有残留）。
  - 容器里访问网络失败。
  - 容器里写只读路径失败。

## 7. 交付时请说明

- 改了哪些文件，新增的配置项。
- 镜像构建命令、构建耗时和大小。
- 用真实模型各验证了哪家的工具调用（Claude 走中转站、GPT 走中转站、DeepSeek 直连），有没有哪家不支持或格式不同。如果你那边没法调用真实模型，就说明没验证，Claude 会来跑。
- 离线测试数量和结果，以及 Docker 集成测试是否运行过。
- 契约里你认为需要调整的地方。

## 分工

- **ChatGPT**：以上全部后端内容。
- **Claude**（同步进行，按契约对着模拟后端开发）：
  - run 消息卡片：显示代码、状态、输出、退出码、用时；html 运行可以在浏览器里预览。
  - 成员页的"允许运行代码"开关：模型不支持工具或沙箱不可用时禁用，并说明原因。
  - 设置页显示沙箱状态。
  - 代码块的"在服务器运行"按钮：Python / Node 代码块，以及带测试脚本的 HTML。
  - 你交付后，Claude 负责审查、联调，并用真实模型测试。
