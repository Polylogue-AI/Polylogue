# Security / 安全说明

## 报告漏洞

请**不要**在公开 Issue 里报告安全漏洞。请使用 GitHub 的私密漏洞报告：仓库页面 → **Security** → **Report a vulnerability**。我们会尽快回复。

Please do not report security issues in public issues. Use GitHub's private vulnerability reporting (Security → Report a vulnerability).

## 部署须知

Polylogue 是给小团队自己部署的，安全性很大程度上取决于你怎么部署：

- **API Key 只放在服务器的 `backend/.env` 里**，浏览器拿不到。不要把 `.env` 提交到仓库或发给别人。
- **公网访问必须用 HTTPS**，并在 `.env` 里设置 `SESSION_COOKIE_SECURE=1`。
- **只用邀请码登录。** 管理员邀请码（`ADMIN_INVITE_CODE`）相当于最高权限，请妥善保管。
- **每个房间、每个人都可以设置预算上限**，防止 Key 被滥用产生高额费用。

## 代码运行

开启 `SANDBOX_ENABLED=1` 后，AI 成员（以及房间里的人）可以在服务器上运行代码。每次运行都在一个新的 Docker 容器里进行：

- 无网络（`--network none`）、根文件系统只读、非 root 用户、去掉所有 capabilities、`no-new-privileges`。
- 限制内存、CPU、进程数和运行时间（默认 20 秒，最长 60 秒），用完即删。
- 代码通过标准输入传入，不挂载宿主机目录。

容器隔离能降低风险，但不能完全消除风险，例如容器逃逸漏洞。只在可信的小团队里开启这个功能，保持 Docker 更新，并且只给需要的成员打开"允许运行代码"（默认关闭，仅管理员可改）。

浏览器里的"运行预览"使用不带 `allow-same-origin` 的沙箱 iframe，并用 CSP 禁止网络请求，运行的代码拿不到本站 Cookie，也读不到页面数据。

## 联通（开发中）

正在开发的"联通"功能会让 Agent 在成员自己的电脑上读写文件、运行命令。它的安全底线见 [`docs/13-联通需求说明.md`](docs/13-联通需求说明.md) 第 4 节：只开放指定目录、权限分级、命令默认逐条审批、一键断开、全程留痕。
