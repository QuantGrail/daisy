# 插件

[English](../en/plugins.md)

插件给 Daisy 加上它本身没有的东西，例如会话启动时注入一个组织自己的提示词、接收外部系统的事件并唤醒会话、给 harness 进程加环境变量。大多数人不需要插件。

**插件默认一个也不启用。** 没启用时，插件的代码不会被加载，它的接口、数据表、环境变量和路径都不存在。

## 插件是什么

一个插件是一个单独的 npm 包（包名见下面「插件名」），导出两半：

- `./server`：Daisy 进程里的一半，可以在会话启动时提供组织的提示词、订阅外部事件并唤醒会话、声明自己的通知种类（名字可以按语言分别给；只在插件启用时出现在通知设置里；没启用时，你给它存的开关原样保留、不起作用）；
- `./runner`：执行会话的一半，可以给会话的 harness 进程加环境变量、声明自己的密钥文件（只问支线读不到）、在执行端的每一轮循环里做点事。

插件只从 `@daisy-ai/daisy/plugin` 导入 Daisy 的东西；Daisy 的核心代码从不按名字引用任何插件。

**插件和 Daisy 运行在同一个进程、同一个系统账户下，能做 Daisy 能做的一切。** 只启用你信得过的插件。

## 插件名

在 `plugins` / `DAISY_PLUGINS` 里写的名字有三种写法，**写什么就加载什么包**：

| 写法 | 例子 | 加载的包 |
| --- | --- | --- |
| 短名 | `my-plugin` | `@daisy-ai/my-plugin` |
| 带作用域的完整包名 | `@acme/daisy-foo` | `@acme/daisy-foo` |
| `npm:` 加不带作用域的包名 | `npm:daisy-plugin-foo` | `daisy-plugin-foo` |

- **不含 `@`、`/`、`:` 的名字一律是短名**，指 `@daisy-ai/<短名>`，和以前完全一样；以前写好的配置不用改。短名只能用小写字母、数字和 `-`，以字母开头，最长 40 个字符。
- 不带作用域的第三方包要写成 `npm:<包名>`。这样短名永远不会被理解成另一个同名的包：`my-plugin` 只会是 `@daisy-ai/my-plugin`，`npm:my-plugin` 才是名叫 `my-plugin` 的包。`npm:@acme/daisy-foo` 和 `@acme/daisy-foo` 一样。
- 完整包名按 npm 包名的规则检查：小写，只用字母、数字和 `-`、`.`、`_`、`~`，不以 `.` 或 `_` 开头，最长 214 个字符。
- 不能是 Daisy 自己的包（`daisy`、`contracts`、`client`、`ui`、`server`、`runner`、`relay`、`a2a-mcp`、`a2a-client`，短名或写在 `@daisy-ai/` 下都不行），也不能是 Node 自带的模块名。
- **只认包名，不认路径**：`./x`、`../x`、`/opt/x`、`C:\x`、`file:`、网址都会被拒绝。

不合法的名字会让 Daisy 拒绝启动，并说明是哪个名字。

插件自己报的名字（`createServerPlugin` / `createRunnerPlugin` 返回的 `name`）要等于启用它时的名字或它的包名：`@daisy-ai/` 下的插件报短名（如 `my-plugin`），其他插件报自己的包名（如 `@acme/daisy-foo`、`daisy-plugin-foo`）。`runner.json` 里给插件的选项写在启用它时用的那个名字下。

## 安装：装在 Daisy 旁边

Daisy 按 Node 的规则、从**它自己安装的位置**往上找插件的包，所以插件装在和 Daisy 同一处就能找到：

- 用 `npm install -g @daisy-ai/daisy` 装的 Daisy：同样用 `npm install -g` 装插件，例如

  ```sh
  npm install -g @acme/daisy-foo          # 或者 daisy-plugin-foo、插件的 .tgz
  ```

  两者都在 npm 的全局目录（`npm root -g`）下，Daisy 就能找到。改过 npm 全局目录（`npm config set prefix ~/.local`）或安装 Daisy 时带了 `--prefix` 的，装插件时用同一个。Daisy 自己更新（`npm install -g` 新版本）不会动旁边的插件。
- 从代码检出运行（`npm start`）的：在检出的根目录 `npm install --no-save <插件>`（下次 `npm ci` 会把它清掉，要再装一次）。

Daisy **不**从别处找插件：不看 `NODE_PATH`（Daisy 用的 ES 模块不读它），不看数据目录，也不看当前目录。只认装在那几处的包：Node 往更上层目录找到的（例如 Windows 上任何账户都能建的 `C:\node_modules`），或解析到包目录之外的（例如代码检出里 tsconfig 的 `paths` 映射），都不加载。

## 启用

先把插件的包装在 Daisy 旁边（见上面「安装」）。然后二选一：

- 数据目录的 `runner.json` 里写 `plugins`（开机自启时也生效，推荐）：

  ```json
  { "plugins": { "my-plugin": { "某个选项": "值" }, "@acme/daisy-foo": true, "npm:daisy-plugin-foo": true } }
  ```

  `plugins` 可以是名字的列表（`["my-plugin", "@acme/daisy-foo"]`），也可以是对象：键是插件名，值是交给这个插件的选项，`true` 表示启用、不带选项，`false` 表示不启用。**写了 `plugins` 就以它为准**（写成空的就是一个也不启用），不再看环境变量。

- 环境变量 `DAISY_PLUGINS`，逗号分隔的插件名，例如 `DAISY_PLUGINS=my-plugin,@acme/daisy-foo`。这样启用的插件没有选项。开机自启的 Daisy 收不到你终端里的环境变量（见 [环境变量](environment.md)），所以长期用请写在 `runner.json` 里。

改了之后重启 Daisy（`daisy stop && daisy start`）。启用了却没装，Daisy 不启动，并说“插件「<插件名>」没有安装（找不到 <包名>）”。

## 只有主人能决定加载哪些插件

插件的代码以运行 Daisy 的这个系统账户运行，所以：

- 插件列表只有两个来源：数据目录的 `runner.json` 和你自己设的环境变量 `DAISY_PLUGINS`。Daisy 没有任何接口、命令或网页设置会写这个列表，配对的设备改不了它。
- **已知的限度**：“办”的会话里，AI 以你的账户运行命令，它能改 `runner.json`、能 `npm install -g`——和它能改你账户下的任何文件一样。Daisy 不拦这个；只有“只问”的支线和常驻会话读不到数据目录。所以只在你信得过的工作里让 AI 办事，并留意它改了什么。
- `runner.json` 属于别的账户、或别的账户能改（组或其他人有写权限）、或者读不了时，**Daisy 不启动**，并说明原因：这个文件决定 Daisy 运行什么代码、在哪里运行（插件、更新、AI 的身份目录、工作区）。Daisy 也不会悄悄把它的权限收紧（那样别人写进去的东西就成了你的）；设置更新来源也会被拒绝。先看一眼里面写了什么，确认是你的，再 `chmod go-w`，然后启动。Windows 上不做这项检查（数据目录的权限由系统的访问控制管）。
- `runner.json` 不是合法的 JSON 时，Daisy 不启动，说是哪一行哪一列，改好再启动。
- 只启用你信得过的包；像装别的全局 npm 包一样，留意包名有没有拼错。

## 写一个插件

最小的例子在仓库的 `examples/plugin-hello/`：它给每个会话的 harness 进程加几个环境变量，并说明怎样在代码检出里不安装就试用它。插件能用的挂点和类型，以 `packages/daisy/src/plugins/` 里的定义为准。
