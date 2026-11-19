# ADR-160：插件可以是主人写出的任意 npm 包；短名照旧（P6-16）

- 日期：2026-11-18
- 状态：**已实施（分支 `p6-16`，基于 `p6-gate`；待合入）**
- 来源：D-44 ②（插件不再限于 `@daisy-ai/<名字>`，原有短名写法继续有效，兼容性优先）
- 相关：插件是单独的包、只经 `@daisy-ai/daisy/plugin` 碰核心（P4-13）；ADR-145（更新来源要 PIN）；ADR-156（别的账户能改的 `runner.json` 不采用）；ADR-158（数据目录里的权限每次启动收紧）

## 背景

P1-10 / P4-13 起，`runner.json` 的 `plugins`（或 `DAISY_PLUGINS`）里的名字只能是 `^[a-z][a-z0-9-]{0,39}$`，加载的包固定是 `@daisy-ai/<名字>`。第三方插件只能占用 Daisy 自己的 npm 作用域，等于没法发布。

## 决定

### 1. 三种写法，写什么加载什么

| 写法 | 加载的包 | 插件的键（选项、报名字） |
| --- | --- | --- |
| `my-plugin`（不含 `@`、`/`、`:`） | `@daisy-ai/my-plugin` | `my-plugin` |
| `@acme/daisy-foo` | `@acme/daisy-foo` | `@acme/daisy-foo` |
| `npm:daisy-plugin-foo` | `daisy-plugin-foo` | `npm:daisy-plugin-foo` |

- **不含 `@`、`/`、`:` 的名字永远是短名**，规则和以前逐字相同；已有配置不变。`@daisy-ai/<短名>` 写全也行，和短名是同一个插件。
- 不带作用域的第三方包必须写 `npm:` 前缀。没有选“短名找不到就退回同名的无作用域包”：那样同一行配置加载哪个包取决于机器上碰巧装了什么，`my-plugin` 在没装 `@daisy-ai/my-plugin` 时会去加载一个叫 `my-plugin` 的陌生包（它的 `server` 文件会被当作插件执行）。`npm:` 和 `updateSource` 的 `npm:@daisy-ai/daisy@latest` 是同一种写法。`npm:@acme/x` 等于 `@acme/x`。
- 名字按 npm 包名规则严格检查（小写；`[a-z0-9~-]` 开头，之后 `[a-z0-9._~-]`，不以 `.` 结尾——Windows 会去掉文件名末尾的点，`daisy.` 就是 `daisy`；总长 ≤ 214；作用域形式恰好一个 `/`）。路径（`./`、`../`、`/`、`C:\`、反斜杠）、URL、`file:`、`node:`、Node 内置模块名、`node_modules`、Daisy 自己的包（`daisy`、`contracts`、`client`、`ui`、`app`、`server`、`runner`、`relay`、`a2a-mcp`、`a2a-client`，短名或 `@daisy-ai/` 下）都拒绝，Daisy 不启动并说是哪个名字。这个设置永远不经过路径解析。
- 插件报的 `name` 要等于它的键或它的包名（`@daisy-ai/` 下的照旧报短名；第三方报包名即可，不用知道主人写没写 `npm:`）。
- 代码：`packages/daisy/src/plugins/runner.ts` 的 `pluginPackage`（名字 → 包）、`pluginSelection`（按键去重）、`pluginNameMatches`、`importPlugin`。

### 2. 从哪里找：Daisy 自己安装的位置

`importPlugin` 先 `import.meta.resolve("<包>/<server|runner>")` 再导入：按 Node 的规则从 Daisy 自己的代码所在处往上找 `node_modules`。先单独解析，是为了“没有安装”“没有导出这一半”只在说这个包本身时才这样报，插件自己代码里的导入错误原样抛出。

- `npm install -g @daisy-ai/daisy` 的 Daisy 在 `<prefix>/lib/node_modules/@daisy-ai/daisy`（Windows：`<prefix>/node_modules/…`），往上走到 `<prefix>/lib/node_modules`，正是 `npm install -g <插件>` 放包的地方；插件的 peer 依赖 `@daisy-ai/daisy` 也能从插件那边这样找到。更新（ADR-145）用同一个 prefix 的 `npm install -g`，不碰旁边的插件。
- 代码检出：根目录的 `node_modules`（`npm install --no-save <插件>`）。
- 不加别的来源：`NODE_PATH`（ES 模块不读）、数据目录下的 `plugins/`、当前目录都不找。多一个来源就多一个“谁能往里放代码”的问题，而“装在 Daisy 旁边”已经够用。
- **只认这几处（审查 L1、L2）**：Node 的查找会一直走到文件系统的根——Windows 上 `C:\node_modules` 任何账户都能建；代码检出里 tsx 还会套用当前目录 tsconfig 的 `paths`。所以 `importPlugin` 先在 `pluginRoots()` 里找这个包的目录（Daisy 自己树里的 `node_modules`，以及作为安装包时它所在的那个 `node_modules`，再往上不算），找不到就是“没有安装”；解析出来的文件必须在那个包目录（的真实路径）里面，否则拒绝加载并说解析到了哪里。代码检出里工作区包是 `node_modules` 下的符号链接，按真实路径比较，照常可用；`examples/plugin-hello` 的测试改成按 README 的做法建链接（只靠解析钩子不再算“装了”）。

### 3. 决定运行什么代码的设置只归主人

- 加载插件就是以这个账户运行它的代码；`updateSource` / `autoUpdate` 决定以后装上什么代码；`identityRoot`、`workspaceHome`、`allowedRoots` 决定 AI 的身份目录（里面的设置文件能挂钩子）和工作区放在哪里。核实过：没有任何接口、命令或网页设置写 `plugins`；`runner.json` 的写入者只有第一次启动的 bootstrap（保留原有的键）和设置更新来源（要 PIN，ADR-145）。所以不需要新的 PIN 闸。
- **别的账户的、别的账户能写的、或者看不了的 `runner.json`：Daisy 进程不启动**（审查 M2；第一版只去掉 `plugins`、`updateSource`、`autoUpdate` 三个键，漏了身份目录和工作区）。选“不启动”而不是“只留 `nodeId`”：去掉这些键等于换一个节点运行，比停下来说清楚更难发现；这种文件在正常安装里不会出现（Daisy 总以 0600 写它）。一行英文日志说哪个文件、为什么、怎么办，退出码 1，在拿锁、开数据库之前。
- **只读一次（审查 M1）**：daemon 在一切之前读一次（`readRunnerJson`），插件、更新设置和信任判断都来自这一次；之前插件在打开数据库前读、更新设置和 Runner 设置在之后再读，而打开数据库时 P6-15 的权限收紧会把一个组可写的 `runner.json` 改成 0600——同一次启动里后两次读就把一个被人写过的文件当成了可信的（自动更新会装上它指定的包，不要 PIN）。现在：不可信就不启动；收紧数据目录时，组 / 其他人可写的 `runner.json` 原样留着（`ownerOnlyTree` 的 `leave`，报告里 `left`，日志一行），不再把它“洗”成可信的。Runner 设置仍要在第一次启动的 bootstrap 写下 `nodeId` 之后再读一次，这次也再判断一次，变坏了就不起 Runner、说一行，不抛堆栈（审查 L4）。
- **打开一次、按打开的文件判断（审查 L3）**：`loadRunnerFile` 打开一次，用这个描述符 `fstat` 判断、再用同一个描述符读，中间换不了文件；打不开（不存在除外）或 `fstat` 失败算不可信，不再默认可信。
- **先判断，再解析（审查 L4）**：不可信的文件不解析，所以别人写坏它也只是“不可信”，不会变成别的错误。
- **自动更新（审查 L5）**：不可信时 Daisy 不启动，更新器根本不存在；`readRunnerJson` 对不可信的文件不给任何设置（`config: null`），所以也不会出现“没写 `autoUpdate` 就按默认开”的情况。命令行 `daisy update` 的 `runnerSetting` 同样什么都不取，并在标准错误上说哪个键没有采用。
- **设置更新来源（审查 L6）**：`PUT /api/update/source` 在 `commitLetIn` 的同步块里读、判断、写（`readRunnerJson` → `writeSourceSetting(…, current)`），中间没有别的读；不可信回 409 `runner_json_untrusted`，不是 JSON 回 409 `runner_json_broken`（原来 `writeSourceSetting` 吞掉解析错误、写回只有 `{ updateSource }` 的文件，`nodeId` 等全丢）。两条提示在语言包里（`api.error.runnerJsonUntrusted` / `…Broken`）。
- **Windows（审查 L2）**：`untrustedFile` 在 Windows 上不判断（没有 uid / 模式位；数据目录靠 P5-05 的受保护 DACL），这一节的检查在 Windows 上不生效。
- **已知的限度（审查 L7）**：“办”的会话里 AI 以主人的账户运行命令，能改 `runner.json`、能 `npm install -g`，和它能改主人的任何文件一样；只有“只问”的支线和常驻会话读不到数据目录。指南照实写成限度，不再说“AI 改不了”。

### 4. 不是合法 JSON 的 `runner.json`：Daisy 不启动

原来 daemon 直接 `JSON.parse`，坏文件让启动以一屏堆栈失败；启动设置的代码（ADR-156）则当作非致命问题跳过。现在统一由 `readRunnerJson` 判断（在信任判断之后），说法只有位置（第几行第几列，从不引用文件内容）：

- **Daisy 进程：不启动**，一行 `✗ <路径>：第 N 行第 M 列附近不是合法 JSON — not starting: fix it (or move it away), then start again.`，退出码 1，在拿数据目录的锁、打开数据库之前。不按默认值启动，理由同上：按默认值起来的是另一个节点。
- **命令行：照常**（ADR-156 不变）：`--help`、`status`、`doctor` 不因它失败，`daisy status` / `doctor` 和每条命令的那一行说明它坏了，主人才能用 `daisy` 看清楚再修。

### 5. 不用改的

`scripts/check-core-names.mjs` 认插件靠“导出 `./server` 或 `./runner` 的包”，名字去掉作用域后检查，不依赖 `@daisy-ai`，不改。

## 测试

`tests/plugin-names.test.ts`：三种写法与去重；四十多个非法名字（路径、URL、`file:` / `node:`、大写、Daisy 自己的包含 `app`、内置模块、以 `.` 结尾、超长）都拒绝；短名和 `@daisy-ai/session-tag` 写全加载的是同一个测试插件；**用 `scripts/pack-daisy.ts` 的 `stage` 把 Daisy 摆进一个临时的 npm 全局目录**，旁边放带作用域、不带作用域、`@daisy-ai/` 短名三个插件，用摆进去的那份 `plugins/runner.ts` 加载：都找到、都在那个目录里、插件能找到旁边的 `@daisy-ai/daisy`；这份检出里有、那个目录里没有的 `session-tag` 报“没有安装”；更上层 `node_modules` 里的报“没有安装”（L2）；装在那里却被解析钩子指到别处的拒绝（L1）；只有一半的报“没有 Runner 端”；报错名字的拒绝。信任：`readRunnerJson`（没有、可信、别人能写——什么都不给且不解析、不是 JSON——一行、不含文件内容）；看不了的目录算不可信（L3）；权限收紧留下组可写的 `runner.json`、其余照收（M1）；`daisy update --check` 不用别人能写的文件里的 `updateSource`；`PUT /api/update/source` 对不可信的文件回 409 且一字不改、对坏 JSON 回 409 且不改写（L6），改好后照常写并保留其余键；子进程起 Daisy：别人能写的 `runner.json`（插件、更新来源、身份目录、工作区都指向别处）——退出码 1、一行说明、没建数据库、没有更新器、文件权限没被改（M1、M2、L5）；不是 JSON——退出码 1、一行说明、没有堆栈、没建数据库。

## 后果

- 第三方可以用自己的作用域或无作用域的名字发布插件，用户 `npm install -g` 装在 Daisy 旁边、写进 `runner.json` 即可。
- 不带作用域的包要多写 `npm:`；换来短名的意义永远不变。
- 指南 `docs/guide/{zh-CN,en}/plugins.md` 新三节（「插件名」「安装：装在 Daisy 旁边」「只有主人能决定加载哪些插件」），两种语言的节一一对应；`examples/plugin-hello/README.md`（英文）和 `README.zh-CN.md` 都改了。
- 一个坏的 `runner.json` 让 Daisy 进程起不来（命令行照常，并说哪里坏了）。
- 别的账户的、别的账户能写的、或看不了的 `runner.json` 让 Daisy 进程起不来（Windows 不判断）。
