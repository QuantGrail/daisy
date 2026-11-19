# 一个最小的 Daisy 插件

[English](README.md)

Daisy 的插件是一个单独的 npm 包，导出两半（包名可以是任意合法的 npm 包名，见指南的「插件名」：短名 `example-hello` 指 `@daisy-ai/example-hello`，第三方的包写完整包名，如 `@acme/daisy-foo` 或 `npm:daisy-plugin-foo`）：

- `./server`（控制面）：`createServerPlugin(host)`，可以提供“会话启动时注入组织提示词”（`sessionPrompt`）、“订阅外部事件、唤醒会话”（`events`）和“自己的通知种类”（`notificationKinds`）三个挂点；
- `./runner`（执行端）：`createRunnerPlugin(host)`，可以给会话的 harness 进程加环境变量（`sessionEnv`）、声明自己的密钥路径（只读旁路看不到）、在 Runner 每一轮循环里做点事（`tick`）。

插件只能从 `@daisy-ai/daisy/plugin` 导入 Daisy 的东西（类型、`log`、`OWNER_ID` 等几个工具），核心代码从不导入插件。插件默认不启用：只有按名字启用后它的代码才会被加载。

这个例子（`example-hello`）：

- `src/runner.ts`：给每个会话的 harness 进程加 `HELLO_SESSION`（会话编号）、`HELLO_AGENT`（哪家 harness）、`HELLO_GREETING`（选项 `greeting`）；
- `src/server.ts`：加载时记一行日志，不注册任何挂点。

## 试一下（在这个仓库的检出里）

```sh
npm ci
ln -s ../../examples/plugin-hello node_modules/@daisy-ai/example-hello   # 让 Daisy 能 import 到它
DAISY_PLUGINS=example-hello npm start
```

在一个会话里让 AI 运行 `env | grep HELLO_`，能看到这三个变量。选项写在数据目录的 `runner.json` 里（写了 `plugins` 就以它为准，不再看 `DAISY_PLUGINS`）：

```json
{ "plugins": { "example-hello": { "greeting": "你好" } } }
```

启用了却没装，Daisy 不启动，并说“插件「example-hello」没有安装（找不到 @daisy-ai/example-hello）”。

这个例子的包名在 `@daisy-ai` 下，所以用短名启用。你自己的插件用你自己的包名（例如 `@acme/daisy-hello`）：`createServerPlugin` / `createRunnerPlugin` 返回的 `name` 写这个包名，启用时也写它（`DAISY_PLUGINS=@acme/daisy-hello`）；发布后，用户用 `npm install -g @acme/daisy-hello` 把它装在 Daisy 旁边即可。

## 外部回调

`events.subscribe(host)` 拿到的 `host.scheduler` 可以唤醒会话：`host.scheduler.wake(会话编号, scheduleId, 标签, 文本, { budget })`。如果这次唤醒是“外部系统的结果回来了”（外部回调），`scheduleId` 用 `callbackScheduleId(类别, 条目编号, { human })` 生成（从 `@daisy-ai/daisy/plugin` 导入），例如 `callbackScheduleId("build", "B-42")` 得到 `callback:build:B-42`：

- 类别：小写字母开头，只用小写字母、数字、`_`、`-`，最多 32 个字符；条目编号：字母或数字开头，只用字母、数字、`_`、`.`、`-`，最多 64 个字符。不合这个格式就抛出错误。类别和条目编号的具体样子由插件自己定，Daisy 不认识也不检查。
- `human: true`（得到 `callback-human:…`）表示这是一个人的决定：它引起的一轮不计入常驻会话的每日次数（这一次唤醒受不受每日次数限制，由 `wake` 的 `budget` 选项决定）。
- Daisy 只认这个格式来决定外部回调怎么处理：还没运行就被停止的回调不丢，留到下一轮一起送达；能并入主人自己的消息一起送达；同一条目还在等待时，新的结果并入那一轮。

## 通知种类

插件自己的事件要在通知设置里有一个开关时，在 `createServerPlugin` 返回的对象里声明 `notificationKinds`（类型 `NotificationKindDecl`，从 `@daisy-ai/daisy/plugin` 导入）：

```ts
return {
  name: "example-hello",
  notificationKinds: [
    {
      id: "hello_ping",
      label: { en: "Greeting", "zh-CN": "问候" },
      hint: { en: "The example plugin's greeting", "zh-CN": "例子插件的问候" },
      default: true,
    },
  ],
};
```

- `id`：小写字母开头，只用小写字母、数字和 `_`，最多 32 个字符；不能和 Daisy 自己的种类（`approval`、`task`、`ai_private_message`、`ai_failed`、`retract`）或另一个插件的重名，否则 Daisy 不启动并说是哪个插件。`label` 是人看到的名字（1–40 个字符），`hint` 是说明（可省，最多 200 个字符），`default` 是两台设备上默认开不开（省略为开）。
- `label` 和 `hint` 按语言给，键是语言标签（`{ en: "…", "zh-CN": "…" }`，类型 `PluginText`）：每个人看到自己显示语言的那句（就近匹配，`zh-Hans` 得到 `zh-CN`），没有就用英文的，再没有就用第一句。至少给英文；只给一个字符串也照旧能用，各种语言下都原样显示。
- 声明的种类排在 Daisy 自己的种类后面，出现在 `GET /api/notification-preferences` 的 `kinds` 和 `matrix` 里（`daisy notify show`），可以用 `daisy notify set` 改，推送方查询（`POST …/check`）按它判断。
- 插件没装或没启用时，这个种类哪里都不出现，也不能改；人以前给它存的开关原样留着、不起作用，插件重新启用后照旧生效。

接口的完整定义：`packages/daisy/src/plugins/server.ts`、`packages/daisy/src/plugins/runner.ts`、`packages/daisy/src/plugins/api.ts`，外部回调的格式在 `packages/daisy/src/schedule/callback-jobs.ts`。指南里的说明：[插件](../../docs/guide/zh-CN/plugins.md)。

这个例子由 `tests/examples.test.ts` 经 Daisy 自己的插件加载代码（按名字 import）加载并检查。
