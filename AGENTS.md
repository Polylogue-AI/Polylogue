# AGENTS.md

给在这个仓库里工作的 AI 助手（Claude、ChatGPT/Codex、Gemini 等）看的项目说明。人类读者请看 `README.md` 和 `docs/14-交接说明.md`。

## 项目

Polylogue：多个 AI 模型和几个人在同一个房间里协作（圆桌、流水线、交叉验证、辩论），支持代码运行。前端 `frontend/`（React 19 + Vite + TS，自带模拟后端），后端 `backend/`（FastAPI + LiteLLM + SQLite + WebSocket）。

## 最重要的规则

1. **接口契约 `docs/03-接口契约.md` 是前后端唯一的约定。** 要改接口，先改契约（版本号 +0.1，在"变更记录"写一行），再改代码。前端类型 `frontend/src/api/types.ts` 和契约逐字段对应，冲突时以契约为准。
2. **前端的模拟后端 `frontend/src/api/mock.ts` 是契约的参考实现。** 改了契约，要同时更新模拟后端，保证 `VITE_MOCK=1` 下界面能完整使用。
3. **不要提交机密。** `backend/.env`、`frontend/.env`、数据库文件（`*.db*`）都在 `.gitignore` 里。不要打印、复制或提交任何 API Key。
4. **不要在测试或示例里用真实 Key 和真实模型**，除非人明确要求（会花钱）。默认用假模型模式 `LLM_MODE=fake`。

## 常用命令

```bash
# 后端（在 backend/ 下，Python 3.12+）
pip install -e ".[test]"
python -m pytest -q                                  # 离线测试，不需要 Key 和 Docker
python -m pytest -q --run-docker -m docker           # Docker 集成测试，需要先构建 roundtable-sandbox 镜像
LLM_MODE=fake python -m uvicorn app.main:app --port 8000

# 前端（在 frontend/ 下）
npm install
npx tsc -b --noEmit && npx vite build                # 类型检查 + 构建，提交前必须通过
VITE_MOCK=1 npm run dev                              # 只用模拟后端
VITE_MOCK=0 npm run dev                              # 把 /api 和 /ws 代理到 localhost:8000
```

端到端测试见 `e2e/README.md`。

## 坑

- **环境变量优先于 `backend/.env`。** 如果你运行在一个已经设置了 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` 的环境里（例如 Claude Code），启动真实模式的后端或 CLI 之前，必须先用 `env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_API_KEY` 清掉，否则会用错凭据。不要把你自己运行环境里的凭据复制进项目。
- Claude 5.5 系列默认开启思考，思考的 tokens 也算在 `max_tokens` 里，所以不要用 `max_tokens` 控制字数；这几个模型也不接受 temperature。
- 后端是单进程的，房间状态在内存里。不要加多个 worker。
- 后端 `async` 接口里不要直接调用会阻塞或联网的同步函数（例如 LiteLLM 的 `supports_function_calling` 遇到 Ollama 模型会去连 `localhost:11434`），要放进 `asyncio.to_thread` 或缓存起来。
- Windows Git Bash 会把以 `/` 开头的参数当成路径改写，需要时加 `MSYS_NO_PATHCONV=1`。
- 测试时启动的开发服务器（uvicorn、vite），停止后要确认端口真的释放了，Windows 上经常留下孤儿进程。

## 风格

- 界面文案和文档用简体中文，句子短、说人话。代码注释用中文，解释"为什么"，不复述代码。
- 前端沿用现有组件和 `styles.css` 里的变量，不引入新的 UI 库。
- 后端改动要配离线测试；涉及 Docker 的测试加 `@pytest.mark.docker`。

## 进行中的工作

**联通**：两个人互相调用对方电脑上的 Agent，共享上下文和文件。需求和安全底线见 `docs/13-联通需求说明.md`，接口契约（v0.8）尚未设计。
