# AI Roundtable

几个模型和几个朋友坐在同一张桌子旁，用圆桌讨论、分工流水线、交叉验证、辩论四种方式一起把事情想清楚。私用，2–10 人。

## 目录

| 路径 | 内容 | 负责 |
|---|---|---|
| `docs/01-界面方案评估.md` | 对原 HTML 原型的评估 | Claude |
| `docs/02-分工与协作流程.md` | 谁做什么、怎么交接 | — |
| `docs/03-接口契约.md` | 前后端唯一的约定 | Claude 起草，双方遵守 |
| `docs/04-给ChatGPT的任务书.md` | 发给 ChatGPT 的后端任务 | — |
| `frontend/` | React + Vite + TypeScript 前端，自带模拟后端 | Claude |
| `backend/` | FastAPI + LiteLLM 后端（待交付） | ChatGPT |
| `prompts/` | 角色提示词模板 | 共同 |

## 运行前端

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

`frontend/.env` 里 `VITE_MOCK=1` 时使用浏览器内的模拟后端，不需要启动 backend：任意 6 位邀请码都能进，名字填"林"即为管理员。模拟数据存在内存里，刷新页面会重置。

后端就绪后改成 `VITE_MOCK=0`，Vite 会把 `/api` 和 `/ws` 代理到 `http://localhost:8000`。
