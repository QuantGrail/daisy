# ADR-103：合并之后的目录与包结构

- 日期：2026-11-16
- 状态：按推荐作为施工默认值，阶段关口再确认
- 工作包：P0-05 第 5 项
- 相关：P1-00、P1-02、P1-06、P1-10、P4-（私有插件的适配包、A2A MCP）、P5-01；ADR-101、ADR-104

## 背景

现状（2026-11-16，沿用旧实现的目录结构）：

```
services/server/src   中心服务端，约 3.6 万行，平铺 50 多个文件，app.ts 约 4100 行
services/runner/src   执行程序，约 1.8 万行，adapters/ 下是各家 harness
packages/contracts    契约（zod），聊天和会话混在一起
packages/client       客户端
packages/ui           界面组件
apps/app              Expo 应用壳，网页版由它导出
tests/                160 多个行为测试，平铺
scripts/  以及旧的部署文件
```

根 `package.json` 的 workspaces 只有 `apps/app` 和 `packages/*`；`services/*` 不是包，靠 `tsx` 从源码直接运行。

要做成的东西：一个 Daisy 进程（核心 + 命令行）；契约、客户端、界面三个给界面用的包；一个私有插件的适配包（核心不依赖它）；中转（另一个程序，单独发布）；独立的 A2A MCP（给不装 Daisy 的 harness 用，自带一对密钥）。

还有一个发布上的事实：Node 不对 `node_modules` 里的 `.ts` 文件做类型剥离，所以要发布到 npm 的包（Daisy、中转、MCP）必须编译成 JS，不能像现在这样从源码跑。

## 可选方案

### A. 顶层布局

| 方案 | 后果 |
| --- | --- |
| **A1. 全部进 `packages/*`，每个可发布的程序和库都是一个 workspace 包** | 一种结构、一套构建；命令行包（`bin: daisy`）、中转包（`bin: daisy-relay`）、MCP 包（`bin: daisy-mcp`）天然各自发布；包之间的依赖由 `package.json` 显式声明，“核心不依赖插件包”“中转不依赖核心”可以用依赖检查强制 |
| A2. 可运行的程序放 `services/*`（`services/daisy`、`services/relay`、`services/mcp`），库放 `packages/*` | 和现状更接近，“程序”和“库”一眼分开。但 `services/*` 要加进 workspaces 才能当包发布，最后和 A1 差别只在目录名；两个顶层目录放发布物，新来的人要多理解一层 |
| A3. 原地合并：保留 `services/server`、`services/runner`，服务端直接引入 Runner 的模块 | 改动最小。但目录名从此说谎（没有“服务端”和“执行程序”了），也没给中转、MCP、插件包留位置；阶段 6 开源时还得再搬一次 |

### B. 核心内部怎么分

| 方案 | 后果 |
| --- | --- |
| **B1. 一个核心包，内部按领域分目录**（见下面的推荐树），领域之间的依赖方向写进一份规则，用工具检查 | 一个包、一次构建，合并进程（P1-02）时不需要先定义一堆包接口；领域边界靠目录和依赖规则维持 |
| B2. 核心拆成多个包（会话、harness 适配、A2A、存储……） | 边界最硬。但这些包只有核心一个使用者，拆包要为每一刀定义稳定接口，阶段 1 赶工期时这是纯成本；包之间的循环依赖会在拆的时候集中爆出来 |

### C. 核心、MCP、中转共用的 Node 端代码放哪

身份密钥与令牌（ADR-099）、A2A 客户端、数据目录与平台差异（ADR-102）、中转的控制协议（ADR-100）会被两三个程序用到。

| 方案 | 后果 |
| --- | --- |
| C1. 放进 `contracts` | 少一个包。但 `contracts` 要给浏览器和手机界面用，放进 `node:crypto`、文件系统代码会把 Node 依赖带进界面 |
| **C2. 新建一个 Node 端共用包（暂名 `kit`）** | `contracts` 保持“只有类型和校验、浏览器可用”；MCP 和中转只依赖 `kit` 和 `contracts`，不用拉整个核心 |
| C3. MCP 直接依赖核心包 | 不用抽共用件，但独立 MCP 会带上整个 Daisy（harness 适配、数据库……），违背“装一个独立的小 MCP” |

## 推荐

**A1 + B1 + C2。** 包名里的 `@<scope>` 等命名决定（后来定为 `@daisy-ai`）；在那之前仍用旧的包名前缀。

### 目标结构

```
packages/
  contracts/   @<scope>/contracts   契约：zod 定义，接口定义唯一的一份（P1-06）；浏览器可用
  client/      @<scope>/client      HTTP + WebSocket 客户端，能同时连多个 Daisy；浏览器可用
  ui/          @<scope>/ui          界面组件
  kit/         @<scope>/kit         Node 端共用件：身份密钥与令牌、A2A 客户端、数据目录与平台差异、中转控制协议
  daisy/       @<scope>/daisy       Daisy 进程 + 命令行（bin: daisy）
    src/
      main.ts          进程入口：锁数据目录、开两个面、起调度（ADR-101、ADR-102）
      cli/             命令行，子命令由 contracts 生成（P1-06、P1-07）
      faces/           local/、external/：两个入口面的路由注册与凭据过滤（ADR-101）
      sessions/        会话、队列、条目、事件、实时推送（原 server：app.ts 的会话部分、store.ts、live.ts、queue-*、native-append、steer-requeue……）
      turns/           一轮的执行（原 runner：worker、live、operations、result-journal、file-checkpoints、worktrees、transcript-carry……）
      harness/         claude/、codex/、acp/（原 runner/adapters；kimi.ts 改成通用 ACP）
      approvals/       审批与提问（原 approvals、native-approvals、wake-approvals、bypass-policy）
      schedule/        定时与后台（原 scheduler、background-tasks、background）
      tools/           给 harness 的 MCP（原来的进程内工具模块）
      prompts/         分层提示词的通用机制（原 prompt-layers 的通用部分）
      access/          PIN、配对、互认、调用授权、白名单（阶段 4 扩充）
      a2a/             A2A 服务端（阶段 4）
      relay-link/      中转连接（阶段 5）
      store/           SQLite、结构版本、备份与退回（ADR-104）
      update/          更新与重启（ADR-104）
      platform/        三个系统的差异：进程树回收、伪终端、自启动、文件权限
      plugins/         插件缝隙：两个挂点（P1-10）
  （私有插件包，不在公开仓库）     实现插件缝隙；核心不依赖它
  mcp/         @<scope>/mcp         独立的 A2A MCP（bin: daisy-mcp）
  relay/       @<scope>/relay       中转（bin: daisy-relay），单独发布
apps/app/      网页版和手机壳（不动）
tests/         按包分子目录：tests/daisy/、tests/relay/……
```

### 依赖规则（写成检查，进持续集成）

- `contracts`、`client`、`ui` 不依赖任何 Node 专用模块。
- `kit` 只依赖 `contracts`。
- `daisy` 依赖 `contracts`、`kit`；**不依赖私有插件包**（插件包由配置加载）。
- 私有插件包依赖 `daisy` 暴露的插件接口（放在 `contracts` 或 `daisy` 的公开导出里），不反向。
- `mcp` 依赖 `contracts`、`kit`；不依赖 `daisy`。
- `relay` 只依赖 `kit` 里的中转协议部分；不依赖 `daisy`。
- `daisy` 内部：`faces/external` 和 `relay-link` 拿不到 `faces/local`（ADR-101 的“中转进来的只到对外面”在结构上成立）；`harness/` 不依赖 `a2a/`、`access/`。
- 核心代码里搜不到私有插件的名字（不装它，其余验收照常通过；阶段 4 完全做到）。

### 迁移路径（与现有工作包衔接）

1. **P1-00 拆大文件：原地拆，不搬目录。** `app.ts`、`store.ts`、契约的 `index.ts` 按领域拆成多个文件，仍在 `services/server/src`、`packages/contracts/src` 下。拆分时文件名按上面的目标领域起，为下一步铺路。“只移动代码，不改行为”和“搬目录”不放在同一个提交里，免得审查时看不出是否改了行为。
2. **P1-01 拿走聊天：原地删。**
3. **P1-02 合并进程：原地合并。** 服务端的启动入口直接创建 Runner 的工作循环，原来跨进程的调用换成一个进程内接口（形状尽量保持原样，保留原来的接缝），删掉 `transport.ts` 和 `/api/runner/*`。这时仍在 `services/` 下。
4. **新增一个纯搬家的工作包（建议编号 P1-02b）：在 P1-02 合并、测试全绿之后，把 `services/server/src` 和 `services/runner/src` 用 `git mv` 搬进 `packages/daisy/src/<领域>/`。** 只改导入路径，不改任何逻辑；同一个提交里不夹带别的改动，`git log --follow` 和 `blame` 能追到原文件。选这个时间点，是因为它要动几乎所有文件，必须在没有别的工作包并行改核心时做（P1-02 和 P1-03 本来就建议先后做，搬家插在两者之间，或在 P1-03 之后、P1-07 之前）。带旧名字的文件在这一步改名（按命名决定）。
5. **P1-06 / P1-07**：命令行和接口定义直接在新位置写。
6. **P1-09**：开始需要构建产物（编译成 JS）和 `bin`；包名按命名决定（`@daisy-ai` 前缀）。
7. **P1-10**：插件缝隙在 `daisy/src/plugins/`；阶段 4 再把私有插件的代码搬进私有插件包（不在公开仓库）。
8. **阶段 4**：抽 `kit`（身份、A2A 客户端），建 `mcp`。
9. **阶段 5**：建 `relay`。

## 对工作包的影响

- **P1-00、P1-02**：原地做，文件名按目标领域起；不搬目录。
- **新增 P1-02b（纯搬家）**：需要调度 agent 写进施工计划；它和其他改核心的工作包互斥。
- **P1-06**：接口定义在 `contracts`，按面打标签（ADR-101）。
- **P1-09**：构建（编译成 JS、打 `bin`）从这一步开始；根 `package.json` 的 `start` 脚本改成运行 `packages/daisy`。
- **P0-01 持续集成**：加依赖规则检查（可以用一个小脚本扫导入，或现成的依赖检查工具）。
- **阶段 4、5**：`kit`、`mcp`、`relay` 和私有插件包四个新包按上面的规则建。

## 待维护者决定的问题（已答复：按推荐作为施工默认值；中转和独立 MCP 与 Daisy 同一个仓库、单独发布）

1. **顶层布局：全部进 `packages/*`（A1），还是程序放 `services/*`、库放 `packages/*`（A2）？** 推荐 A1：一种结构、各自发布、依赖显式。
2. **同意加一个“纯搬家”的工作包（P1-02b），在合并进程之后一次搬完吗？** 推荐同意。替代做法是 P1-00 拆分时就直接拆到新目录，代价是“拆”和“搬”混在同一批提交里，审查难以确认没改行为，而且那时 Runner 还没合并，搬一半会更乱。
3. **中转和独立 MCP 放在同一个仓库里（作为单独发布的包），还是另建仓库？** 推荐同一个仓库：共用 `kit` 和 `contracts`，一处持续集成；设计里说的“单独发布”指单独的 npm 包和版本，不必单独仓库。另建仓库要先问维护者。
