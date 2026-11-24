# 端到端测试脚本

浏览器测试用 `playwright-core` 驱动**本机已安装的 Chrome**，不下载浏览器。真实模型测试用 Python，需要后端的虚拟环境。

```bash
cd e2e
npm install
# Chrome 不在默认路径时：
export CHROME_PATH="/path/to/chrome"
```

## 约定

| 端口 | 用途 | 启动方式 |
|---|---|---|
| 5179 | 前端，模拟模式 | `cd frontend && VITE_MOCK=1 npx vite --port 5179` |
| 5180 | 前端，连后端 | `cd frontend && VITE_MOCK=0 npx vite --port 5180` |
| 8000 | 后端（假模型或真实模式） | 见下 |

测试用的管理员邀请码是 `TBLE27`，启动后端时要传 `ADMIN_INVITE_CODE=TBLE27`。邀请码不能含 O 和 I。

```bash
# 假模型后端（不花钱，不需要 Key）
cd backend
LLM_MODE=fake ADMIN_INVITE_CODE=TBLE27 DATABASE_PATH=/tmp/e2e.db python -m uvicorn app.main:app --port 8000

# 真实模式后端（会花钱）。如果终端里有 ANTHROPIC_BASE_URL 等变量（比如在 Claude Code 里运行），
# 一定要先清掉，否则会覆盖 backend/.env 里的配置
env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_API_KEY \
  LLM_MODE=real ADMIN_INVITE_CODE=TBLE27 DATABASE_PATH=/tmp/real.db python -m uvicorn app.main:app --port 8000
```

截图保存到第一个参数指定的目录，例如 `node smoke.js shots`。

## 浏览器测试

| 脚本 | 需要 | 测什么 |
|---|---|---|
| `smoke.js` | 5179 | 冒烟：登录、房间列表、流式输出、@ 点名、新建房间、各页面 |
| `models.js` | 5179 | 成员页：手动输入模型名、不支持温度时禁用滑杆 |
| `runner.js` | 5179 | 浏览器运行预览：报错收集、沙箱隔离、本地保存、发回房间 |
| `coderun.js` | 5179，或加参数 `real <房间ID>` 用 5180 | 代码运行：运行卡片、"允许运行代码"开关、设置页沙箱状态、"在服务器运行" |
| `pages.js` | 模拟模式构建 + `vite preview --base /polylogue/ --port 5181` | GitHub Pages 演示版：子路径、深链接 |
| `real.js` | 5180 + 假模型后端 | 两个浏览器同时在线：断线重连、插话、打断 |
| `m3.js` | 5180 + 假模型后端 | 流水线、交叉验证、辩论，含并发阶段的打断和继续 |

## 真实模型测试（会花钱）

| 脚本 | 测什么 | 参考费用 |
|---|---|---|
| `real_modes.py <输出目录> [模式,…]` | 四种模式各跑一场，统计需要返回 JSON 的步骤能不能解析 | 全部约 ¥0.9，只跑流水线约 ¥0.1 |
| `real_tools.py <输出文件>` | 三家模型都允许运行代码，跑一轮圆桌，检查工具调用和运行结果 | 约 ¥0.2 |

两个脚本都会创建 Claude、GPT、DeepSeek 三位成员，模型名写在脚本里，按你的 `.env` 修改。需要后端以真实模式运行，`real_tools.py` 还需要 `SANDBOX_ENABLED=1` 和构建好的沙箱镜像。

## 诊断脚本

直接调用 LiteLLM，排查 Key、中转站、截断、工具调用的问题。都会读取 `backend/.env`，**不会打印 Key**。

```bash
cd backend
python ../e2e/diag_relay.py .      # Anthropic 是否能连通（流式 / 非流式）
python ../e2e/diag_short.py .      # 回复被截断时，查看结束原因和思考 tokens
python ../e2e/diag_openai.py .     # OpenAI 是否能连通
python ../e2e/diag_tools.py .      # 工具调用（流式 / 非流式）
```

`repro_cross_interrupt.py` 用来复现"交叉验证在并发阶段被打断"的问题，留作回归测试。
