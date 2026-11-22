# AI Roundtable 后端 · M2

使用 Python 3.12 或更高版本，在项目的 `backend/` 目录运行。

```powershell
python -m pip install -e '.[test]'
$env:LLM_MODE = 'fake'
python -m uvicorn app.main:app --port 8000
```

假模型模式无需 API Key。空库会生成管理员和六位 AI 成员。配置了 `ADMIN_INVITE_CODE` 时用该邀请码登录，否则使用本地联调默认值 `TABLE2`。首次登录绑定姓名。测试第二位用户时，管理员先通过 `POST /api/invites` 生成邀请码。

环境变量优先于 `backend/.env`。`DATABASE_PATH` 默认为 `roundtable.db`，`FAKE_LLM_DELAY` 默认为每字 0.03 秒。可用 `DEFAULT_MONTHLY_LIMIT_CNY` 为新用户设置月预算，留空表示不限。仅在通过 HTTPS 访问时设 `SESSION_COOKIE_SECURE=1`。

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

测试使用假模型或模拟的 LiteLLM 响应。CLI 的真实模式读取 `.env` 中的厂商凭据，按配置的模型逐个检查 Key。M2 联调使用假模型。

## v0.2 实现范围

- 邀请码登录和管理、成员与模型、房间与用量接口。成员写操作、邀请码管理限管理员。用量按房间创建者和 AI 成员记账，月份和日期按 UTC+08:00 计算。
- 圆桌支持逐字广播和断线快照、发言和方向指示、按顺序处理 @、暂停和恢复、打断和跳过、预算停止及单次重试。
- 非圆桌房间可创建和查看，启动编排属于 M3。连接一个已创建的非圆桌房间后发送 `start` 会收到 `mode_unavailable`。
- 运行状态由单进程管理。意外重启时，进行中和暂停中的讨论会被标记为 `error`，已落库的消息和费用仍可查看。
- 重连的 `last_seq` 应发送最高的连续已完成消息序号。后端会附上正在输出的消息，即使其 `seq` 等于或小于 `last_seq`。当前前端在 `message_start` 就推进游标，流中断线且该条消息在重连前结束时，可能漏掉最终全文。前端目前也没有接入邀请码管理界面。
- 后端按 `say.mentions` 的数组顺序调度。当前前端按座位顺序生成该数组，连续输入多个 `@` 时可能与输入顺序不同。
