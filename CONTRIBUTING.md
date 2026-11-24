# Contributing / 参与贡献

欢迎提 Issue 和 Pull Request。

## 开发流程

1. Fork 或在仓库里新建分支，分支名建议 `feature/xxx`、`fix/xxx`。
2. **改接口先改契约。** 前后端之间唯一的约定是 [`docs/03-接口契约.md`](docs/03-接口契约.md)。要增加或修改字段、事件、行为，先在 PR 里修改契约（版本号 +0.1，在"变更记录"写一行），再改代码。同时更新前端类型 `frontend/src/api/types.ts` 和模拟后端 `frontend/src/api/mock.ts`。
3. 提交前在本地通过：
   ```bash
   cd backend && python -m pytest -q
   cd frontend && npx tsc -b --noEmit && npx vite build
   ```
   PR 会自动运行同样的检查（`.github/workflows/ci.yml`）。
4. 发起 Pull Request，说明改了什么、为什么改、怎么测的。至少由另一位维护者审查后合并。

## 约定

- 文档和界面文案用简体中文；代码注释解释"为什么"。
- 后端改动配离线测试，默认用假模型模式（`LLM_MODE=fake`），不要在测试里调用真实模型。
- 不要提交 `.env`、数据库文件或任何 API Key。
- 用 AI 助手开发的话，让它先读 [`AGENTS.md`](AGENTS.md)。

## 新手入门

先读 [`docs/14-交接说明.md`](docs/14-交接说明.md)：项目现状、本地运行方法、容易踩的坑。

---

Issues and pull requests are welcome. The interface contract in `docs/03-接口契约.md` is the single source of truth between frontend and backend: update it (and bump its version) before changing any API. Run the backend tests and the frontend type check/build before opening a PR.
