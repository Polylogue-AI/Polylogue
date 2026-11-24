# 发给 ChatGPT 的消息：模型"可用"状态在启动后全部为 false

> 使用方法：把下面分隔线以下的内容整段发给 ChatGPT。

---

v0.5 的修改已验收并提交（`e11ef53`），37 项测试全部通过。项目负责人在真实模式下使用时发现一个问题。

## 问题：刚启动的后端把所有服务商都显示为不可用

**现象**：真实模式下启动后端，还没有发起任何讨论时，设置页里每家服务商都显示"Key 未配置或检测失败"。Anthropic、OpenAI、DeepSeek 的 Key 都已经在 `.env` 里配置好，也都调用成功过（见 `docs/real-run/`）。

**原因**：`LiteLLM.provider_available` 第一行是 `if not self.provider_checks.get(provider, False): return False`。这个服务商还没有被调用过时，`provider_checks` 里没有它的记录，`get` 取到默认值 `False`，于是直接返回不可用。所以只有成功调用过一次的服务商才会显示可用，重启后又全部变回不可用。

**影响**：不影响调用。但设置页一片红色会误导人。成员页的下拉框里每个模型后面都会带"（Key 不可用）"。"添加模型成员"会默认选第一个可用的模型，现在一个可用的都没有，新成员的模型名就是空的。

**契约的含义**（第 2 节）：`available` 表示"Key 已配置，且最近一次检测成功"。还没有检测过时，只看 Key 有没有配置。

**改法建议**：
- 有调用记录时，按最近一次的结果。最近一次失败就返回 `false`。
- 没有调用记录时：
  - 普通服务商：只看 `validate_environment(model)` 返回的 `keys_in_environment`。
  - Ollama 不需要 Key，可以保持现在的做法，没检测过就返回 `false`。也可以探测一下本机的 Ollama 服务，你来决定。
- 补测试：真实模式、刚启动、某家的 Key 已配置时，`/api/models` 里这家为 `true`。最近一次调用失败后变为 `false`，之后调用成功又变回 `true`。
