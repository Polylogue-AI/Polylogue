# 发给 ChatGPT 的消息：接真实 API 时发现的问题

> 使用方法：把下面分隔线以下的内容整段发给 ChatGPT。

---

项目负责人填好了三家的 Key，开始用真实 API 测试。Claude 经中转站调用（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，LiteLLM 两个都支持，代码不用改）。另外，命令行讨论的第二位成员已从 Gemini 换成 GPT（`app/cli.py`、`.env.example` 里的 `ROUNDTABLE_OPENAI_MODEL` / `OPENAI_API_KEY`），这是项目负责人要求的，Claude 改的，请知悉。

真实调用发现了两个问题，都是假模型测不出来的。

## 1. 必修：`max_tokens` 被思考用光，Claude 只回几个字

**现象**：`python -m app.cli "怎么组织一次读书会？"`，Claude 第 1 轮只输出"这是第 1"就结束了。

**原因**：`stream_turn` 按 `max_chars × 1.5` 算 `max_tokens`（300 字 → 450）。Claude 5.5 系列（Haiku / Sonnet / Opus）**默认开启自适应思考，思考的 tokens 也算在 `max_tokens` 里**。Claude 用同样的提示词单独复现：

| `max_tokens` | `finish_reason` | 输出 tokens | 正文 |
|---|---|---|---|
| 450 | `length` | 450（思考约 700 字） | "这是第 1 " |
| 4000 | `stop` | 约 830（思考约 640 字） | 完整回答，约 300 字，遵守了字数要求 |

**改法**：
- 不要再用 `max_tokens` 控制字数。字数只写在提示词里（现在已经写了），`max_tokens` 改成一个足够大的安全上限，比如普通发言 4000、结构化步骤 8000。上限只用来防止失控，不能低到会截断思考。
- 可选：Claude 5.5 系列可以通过 `output_config.effort` 降低思考深度（`low` / `medium` / `high`，Haiku 5.5 和 Opus 5.5 默认是 `medium`），讨论发言用 `low` 能省钱、更快。请先确认当前 LiteLLM 版本怎么传这个参数（不确定的话先不做，只改上限）。
- 注意：Opus 5.5 和 Sonnet 5.5 都**不能**关闭思考（`thinking: {type: "disabled"}` 会返回 400），所以不要靠"关思考"来解决。
- 补测试：`FakeLLM` 增加一个"先消耗 N 个 tokens 思考"的选项，断言普通发言的 `max_tokens` 不低于 4000。
- 被截断时（`finish_reason == "length"`）至少要能看出来：建议把这条消息标记为 `interrupted`，或者在日志里记一笔，不要当成正常发言静默保存。

## 2. 温度设置在 Claude 5.5 系列上不起作用

Claude Haiku 5.5 / Sonnet 5.5 设置非默认温度会返回 400，Opus 5.5 已移除温度参数。`llm.py` 用了 `drop_params=True`，所以不会报错，但成员页上的"温度"对这些模型完全无效。建议：`/api/members` 或 `/api/models` 返回一个"该模型是否支持温度"的标记，前端据此禁用滑杆（需要改契约的话，先提出来）。不急，可以放到后面。

## 3. 提醒：环境变量优先于 `.env`

后端和命令行都是"环境变量优先于 `.env`"。如果运行后端的环境里已经设置了 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（比如从带这些变量的终端启动），就会**静默使用那一组凭据**，而不是 `.env` 里配置的。Claude 测试时就踩到了这个坑。建议启动时在日志里打印实际使用的 Anthropic 地址（只打印地址，不打印 Key），并在 README 里写明这条规则。

---

## 补充：三家真实讨论已跑通，又发现三个问题

OpenAI 也改为经中转站（`OPENAI_BASE_URL=https://your-openai-relay.example.com/v1`，LiteLLM 支持，代码不用改）。该中转站没有 `gpt-5-mini`（请求会返回 503），项目负责人选了 `openai/gpt-6.1-sol`，已写进 `.env`。

之后 `python -m app.cli "怎么组织一次读书会？"` 完整跑通：三家各发言两轮，DeepSeek 汇总，总费用 ¥0.0531，三家都能正常算出费用。

### 4. 第 1 条的截断是随机出现的，仍然必须修

这次 Claude 两轮都完整输出了，前一次同样的问题却只输出了"这是第 1"。思考用多少 tokens 每次不一样，450 的上限有时够、有时不够，所以第 1 条仍然要按上面的方法修。

### 5. 模型会模仿历史记录的格式，在回复开头加上自己的名字

第 2 轮 GPT 和 DeepSeek 的回复开头分别是 `[GPT（可行性评估）]：` 和 `[DeepSeek（风险与汇总）]：`。原因是 `build_context` 把历史发言写成 `[名字（角色）]：内容`，模型看了几条之后照着这个格式写。界面上已经显示了名字和角色，这个前缀是重复的。

**改法**：在"现在轮到你"那条消息里加一句"直接写发言内容，不要在开头加名字或角色"；同时在保存前去掉回复开头和本人名字匹配的 `[…]：` 前缀作为兜底。补一个测试：假模型回复带这个前缀时，保存下来的内容没有前缀。

### 6. 日志里反复出现 LiteLLM 的 "Provider List" 提示

每次轮到 DeepSeek 都会打印两行红色的 `Provider List: https://docs.litellm.ai/docs/providers`。费用照常算出来了，应该是某个辅助调用（价格查询、token 计数或"最便宜模型"判断）传了 LiteLLM 不认识的模型名，被吞掉了异常但没吞掉打印。请查一下是哪个调用，修正模型名或设置 `litellm.suppress_debug_info = True`。
