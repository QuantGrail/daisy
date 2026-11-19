# 安全问题报告 / Security policy

## 怎么报告 / Reporting a vulnerability

**请不要在公开的 issue、讨论或合并请求里报告安全问题。**
**Please do not report security issues in public issues, discussions or pull requests.**

用 GitHub 的私密漏洞报告：在仓库的 **Security** 页点 **Report a vulnerability**（<https://github.com/QuantGrail/daisy/security/advisories/new>）。报告只有你和维护者看得到；修复和公告也在那里协调。

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on the repository (<https://github.com/QuantGrail/daisy/security/advisories/new>). Only you and the maintainers see the report; the fix and the advisory are coordinated there.

请尽量写上 / Please include:

- 受影响的组件和版本（`daisy --version`、`daisy-relay --version`、`daisy-mcp --version`）和操作系统；
  the component, version and OS;
- 能复现的步骤或概念验证，以及你认为的影响（谁能对谁做什么）；
  steps or a proof of concept to reproduce it, and the impact as you see it (who can do what to whom);
- 不要附带真实的凭据、令牌、PIN 或别人的数据。
  no real credentials, tokens, PINs or other people's data.

我们会尽快确认收到，和你一起确定问题和修复时间，修复发布后在公告里致谢（除非你不希望署名）。请在修复发布之前不要公开细节。

We will acknowledge the report, work out the issue and a timeline with you, and credit you in the advisory once a fix is out (unless you prefer not to be named). Please keep the details private until then.

## 范围 / Scope

在范围内 / In scope：这个仓库里的全部代码——Daisy 进程和 `daisy` 命令、本地网页、`daisy-relay`、`daisy-mcp`（`@daisy-ai/a2a-mcp`）、`@daisy-ai/a2a-client`、契约和客户端包。尤其是：

- 没有互认、没有授权的人调用到 agent，或读到对话、工作目录、凭据；
- 不输入 PIN 就能“放别人进来”（导入名片、开放 agent、配对设备、选择中转等）；
- AI 的工作凭据越出它这一轮、这个会话的范围；
- 中转能读到或篡改经过它的内容，或把连接递给错误的 Daisy；
- 日志、错误信息、审计里出现凭据、令牌、PIN。

不在范围内 / Out of scope：各家 harness（Claude Code、Codex、Kimi Code CLI 等）自身的问题，请报告给它们的作者；别人运营的中转的运维问题；需要已经控制了主人的系统账户才能做到的事。

## 支持的版本 / Supported versions

只对最新发布的版本提供安全修复。Security fixes go to the latest release only.

| 版本 / Version | 支持 / Supported |
| --- | --- |
| 0.1.x | 是 / yes |
