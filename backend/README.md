# AI Roundtable 后端 · M3

使用 Python 3.12 或更高版本，在项目的 `backend/` 目录运行。

```powershell
python -m pip install -e '.[test]'
$env:PYTHONIOENCODING = 'utf-8'
$env:LLM_MODE = 'fake'
python -m uvicorn app.main:app --port 8000
```

假模型模式无需 API Key。空库会生成管理员和六位 AI 成员。配置了 `ADMIN_INVITE_CODE` 时用该邀请码登录，否则使用本地联调默认值 `TABLE2`。首次登录绑定姓名。测试第二位用户时，管理员先通过 `POST /api/invites` 生成邀请码。

环境变量优先于 `backend/.env`。启动前检查终端中继承的 `ANTHROPIC_API_BASE`、`ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN`，以免选错中转站或凭据。真实模式输出 Anthropic 地址的协议、主机和端口。`DATABASE_PATH` 默认为 `roundtable.db`，`FAKE_LLM_DELAY` 默认为每字 0.03 秒。可用 `DEFAULT_MONTHLY_LIMIT_CNY` 为新用户设置月预算，留空表示不限。仅在通过 HTTPS 访问时设 `SESSION_COOKIE_SECURE=1`。

启动前端时，从 `frontend/` 运行以下命令，连接到本地后端。

```powershell
$env:VITE_MOCK = '0'
npm run dev
```

## 测试与命令行

```powershell
python -m pytest -q
python -m app.cli --fake "怎么组织一次读书会？"
```

测试使用假模型或模拟的 LiteLLM 响应。CLI 的真实模式读取 `.env` 中的厂商凭据，按配置的模型逐个检查 Key。真实服务启动时需要配置 `ADMIN_INVITE_CODE`。

## v0.4 模式与实时事件

- 邀请码登录和管理、成员与模型、房间与用量接口。成员写操作、邀请码管理限管理员。用量按房间创建者和 AI 成员记账，月份和日期按 UTC+08:00 计算。
- 圆桌支持逐字广播和断线快照、发言和方向指示、按顺序处理 @、暂停和恢复、打断和跳过、预算停止及单次重试。
- 流水线最多拆成 5 项任务。同一房间内，每位执行者一次处理一项任务，不同执行者可同时提交。执行和返工只读取计划与当前任务的稿件和退回意见，审查围绕当前稿件的完成度、事实和可执行性。每项任务最多返工 `rounds` 次，汇总会区分通过和未通过的成果。后台日志记录脱敏后的调用失败原因。
- 交叉验证先并发独立回答，再以匿名代号互评并打分，最后由主席给出共识、分歧和结论。辩论每轮按正方、反方和裁判的顺序发言，多个同侧成员按轮轮换，裁判每轮评分并在末尾裁决。
- 普通发言逐字推送，字数要求写在提示词里。普通发言的输出上限为 4000 tokens，JSON 步骤为 8000 tokens，校验后将正文转换成 Markdown。触及上限会记录日志，已保存的房间发言标记为 `interrupted`。并发时 `speaker_id` 指向最早仍在发言的成员，快照包含所有正在输出的发言。打断会保留已输出的部分并暂停整批，继续后只重启被打断的调用，新发言使用新的 ID 和序号。跳过只终止当前发言，该调用不重做。每次调用前检查预算，并发调用的费用可能同时结算。
- `/api/models` 合并内置模型、`EXTRA_MODELS` 和成员正在使用的模型。用逗号分隔各项，例如 `EXTRA_MODELS=openai/gpt-6.1-sol=GPT-6.1 Sol,ollama/qwen3:8b`。省略显示名时使用首个 `/` 后的部分。配置中的显示名优先于内置名称。
- `/api/models` 返回 `supports_temperature`。值为 `false` 时，模型调用省略 `temperature`，成员保存的温度设置仍可在换回支持的模型时使用。真实模式冷启动时按 Key 是否配置标记可用，最近一次调用失败后标为不可用。Ollama 需先成功调用一次。假模型模式下候选项均可用。
- 后续提示会纳入所有已保存的方向指示。上下文超过 20,000 tokens 时，使用候选 AI 成员里按 LiteLLM 价格估算最便宜的可用模型压缩最早已结束轮次。摘要落库并计费用，原文仍可从房间历史查看。尚未结束的轮次暂用原文，匿名互评使用独立上下文。
- 运行状态由单进程管理。意外重启时，进行中和暂停中的讨论会被标记为 `error`，已落库的消息和费用仍可查看。
- 重连按最高连续已完成的 `last_seq` 补发后续消息和仍在输出的内容。多个 `@` 按 `say.mentions` 数组顺序处理。


## v0.7 代码运行

在项目根目录构建 Docker 镜像。镜像包含 Python 3.12、pytest、Node.js 22、Playwright 和 Chromium。首次构建会下载浏览器和系统依赖。本机使用下方 Debian 方案构建的镜像约 1.31 GB。

```powershell
docker build -t roundtable-sandbox backend/sandbox
docker image ls roundtable-sandbox
```

Playwright CDN 下载受阻时，也可以使用 Debian 的无头 Chromium，测试仍由 Playwright 执行。下面的命令同时覆盖软件源和安全更新源。

```powershell
docker build -t roundtable-sandbox --build-arg DEBIAN_MIRROR=https://mirrors.ustc.edu.cn/debian --build-arg DEBIAN_SECURITY_MIRROR=https://mirrors.ustc.edu.cn/debian-security --build-arg CHROMIUM_SOURCE=debian backend/sandbox
```

在 `backend/.env` 设置 `SANDBOX_ENABLED=1` 后重启后端。真实模式由 Docker 运行代码。假模型模式启用后使用模拟运行结果，无需 Docker。只有管理员能启用成员的 `can_run_code`，默认关闭。

| 配置项 | 默认值 | 用途 |
|---|---|---|
| `SANDBOX_ENABLED` | `0` | `1` 开启 |
| `SANDBOX_IMAGE` | `roundtable-sandbox` | 预先构建的镜像名 |
| `SANDBOX_TIMEOUT` | `20` | 单次运行时限，1–60 秒 |
| `SANDBOX_MAX_PARALLEL` | `2` | 全服务并发运行数，超出时排队 |
| `SANDBOX_MAX_RUNS_PER_TURN` | `5` | 一次 AI 发言的工具调用上限 |
| `SANDBOX_MEMORY` | `512m` | 每个容器的内存上限 |
| `TOOL_MODELS` | 空 | 逗号分隔的完整模型 ID，用于声明 LiteLLM 尚未识别的工具能力 |

默认测试跳过 Docker。构建镜像后，从 `backend/` 运行集成测试：

```powershell
python -m pytest -q --run-docker -m docker
```

每次运行使用新的容器，代码通过标准输入传入，不挂载宿主目录。后台会在超时和取消时清理容器，启动时回收带项目标签的残留容器。请使用单个后端进程管理同一个 Docker 实例上的沙箱。
