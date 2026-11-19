# ADR-151：开源前删掉已死和已被取代的代码（P6-01）——阶段 4 参考目录、旧部署、git 检出自动更新、Expo 原生应用与 APK 下载

- 日期：2026-11-18
- 状态：**已实施（分支 `p6-01`，基于 `p6-gate`，待合入）**
- 来源：维护者的决定（开源整理：删掉 Expo 原生部分和 APK 下载，手机走浏览器、保留网页外壳；删掉从 git 检出更新的旧自动更新，P5-06 的 npm 更新取代它）
- 相关：旧版的 git 检出自动更新（本 ADR 删掉它）、ADR-145（npm 安装与更新，P5-06；自动更新默认开）、ADR-140（macOS launchd）

## 背景

公开仓库只放整理后的当前文件（维护者的决定）。下面这些在当前产品里已经不跑、或者已有替代，留着只会让读代码的人误以为它们还在用，还带着旧部署路径和仓库地址：

| 删掉的 | 为什么 |
| --- | --- |
| `packages/daisy/src/_phase4/`、`tests/_phase4/` | 阶段 4 的参考摘录，不参与编译和测试（tsconfig 排除）；阶段 4 已按新设计重建，原代码只留在私有仓库的历史里 |
| 旧版服务端的部署目录（监听 8787 的 systemd 单元、Caddyfile 示例）、`workspaces/.gitkeep` 及其 gitignore 行、`tests/fixtures/socket-unit.py` | 旧服务器部署形态；Daisy 由 `daisy start` / `daisy autostart` 管理（ADR-140、ADR-141、ADR-145）。`workspaces/` 只被私有仓库里的一个探针脚本（不公开）用，改为临时目录；`socket-unit.py` 没有任何引用 |
| `update/autoupdate.ts`、`scripts/runner-launch.sh`、`scripts/runner-guard.mjs`、`tests/runner-autoupdate*.test.ts`、`tests/nodes.test.ts`（只检查 runner-launch.sh） | 旧版的 git 检出自动更新：从 GitHub 上旧的私有仓库的 main 取代码、`releases/<commit>` + `current` 软链 + launch.sh 守卫。只服务“代码检出 + 启动器”的旧安装形态；npm 安装的 Daisy 由 P5-06（ADR-145）更新 |
| `apps/app/eas.json`、app.json 的 slug / scheme / iOS bundle / Android package / 原生插件、app.config.js 的 `HARBOR_TEST_HTTP` 与 `expo-build-properties`、`App.tsx` 的 `expo-secure-store` 分支与 `EXPO_PUBLIC_HARBOR_URL`、依赖 `expo-secure-store` / `expo-build-properties` / `expo-system-ui`、`npm run build:native` / `build:android:test`、`scripts/build-android.sh`、`scripts/install-android-toolchain.sh` | Expo 原生应用（维护者的决定：手机用浏览器打开） |
| `GET /api/client-builds`、`GET /api/client-builds/android`（`app/builds.ts`、契约 `system.clientBuilds` / `clientBuildAndroid`、命令 `daisy client-build show/download`）、客户端 `downloadAndroidBuild()`、设置页“Android 测试客户端”卡片、`tests/builds.test.ts`；`createApp` 的 `projectDir` 选项（只给这条路由找 APK） | 本机生成的 Android 测试包的下载；原生应用没了，它也没了 |

## 决定

1. **网页外壳保留，只留最小配置。** `apps/app/app.json` 只剩 `name`、`platforms: ["web"]` 和 `web`（名字、语言）；Expo 由 `name` 推出 slug，`npm run build:web` 照常导出 `apps/app/dist`。`app.config.js` 只剩 `HARBOR_BASE_PATH`（子路径部署）。`daemon.ts` 提供 `apps/app/dist`、`pack-daisy.ts`、e2e 脚本、`daisy doctor` 都不变。`packages/ui` 里给原生宿主留的分支（`platform.ts` 的文件选择 / 分享、`terminal-frame.tsx` 的 WebView、`chat-icons.native.tsx`）不在本包范围，没动；它们用到的 `expo-document-picker`、`expo-file-system`、`expo-sharing`、`react-native-webview`、`react-native-svg` 仍在 `apps/app` 的依赖里（网页打包要解析它们的导入）。
2. **自动更新只剩 npm 这一条。** 节点上报的 `capabilities.runner.autoUpdate` 改由 `update/package.ts` 的 `nodeAutoUpdate()` 算（原来在 worker 里内联、不是 npm 安装时退回 git 更新器的状态）。状态：`unsupported`（带原因：不是 npm 全局安装，或这个进程没接上更新）、`no-source`、`current`、`disabled`（自动更新开关 runner.json `autoUpdate: false`，且没有新版本）、`available`（开关关着时找到的新版本，等主人 `daisy update --apply`）、`pending`（等空闲 / 正在换）、`failed`。git 更新器才有的 `dev`、`older`、`installed` 从设置页和 `daisy status` 的文字里删掉；设置页“自动更新已关闭”不再说“默认关闭，直到升级前备份上线”（自动更新早已默认开），新版本号不再截成 7 位（那是 commit）。`caps.runner.selfRestart` 改为 `upgrade.enabled || (受监管 && npm 更新可用)`；`caps.runner.release` 只取 `.release`（代码检出不再读 git HEAD，与 `daemon.ts` 的 `release` 一致）。runner.json 的 `runnerHome`、`updateConfirmMs`、`allowDowngrade` 不再读（只给 git 更新器用；npm 更新的退回由 `--allow-downgrade` 按次给）。
3. **`restart.ts` 里旧 LaunchAgent 标签（旧组织域名开头的 `com.*`）的判断：删。** 那是旧 launch.sh `--supervise` 在旧 LaunchAgent 下的标签判断，属于被删的更新器。`HARBOR_RUNNER_SELF_RESTART=1` 仍表示“另有监管者会把它再拉起”，管理者一律记为 `supervise`；macOS 的 launchd 只认 `daisy autostart` 写的 `DAISY_LAUNCHD_LABEL`（ADR-140）。`ownUnit()`（从 cgroup 读 systemd 单元名）仍在用，从 autoupdate.ts 挪进 `restart.ts`。
4. **接口变化。** 少了两条路由（171 → 169，命令 135 → 133）；`docs/api` 重新生成。接口版本不升：这两条只给本机生成的测试安装包用，没有外部调用方。

## 不在本包

改名（`HARBOR_*` → `DAISY_*`、`harbor.auth.v1` 等存储键、`HarborClient` 等标识）是 P6-02～P6-05 的事；`packages/contracts/src/restart.ts` 注释里的“launch.sh --supervise”、`platform/paths.ts` 解释为什么不认 `HARBOR_DATA` 的注释、`update/upgrade.ts` 里一个旧安装路径的说明留给相应的清理包。私有的施工文档（不公开）里对已删脚本的描述不改。

## 后果

- 代码检出（开发者）运行的 Daisy 不再自己从 GitHub 更新：`daisy status` / 设置页说“不是用 npm 全局安装的……更新请在原处手动做”。
- 还在用旧 launch.sh 启动器的机器（P1-02 之前的安装形态）不再自动更新；它们本来就该按安装说明（`docs/guide/zh-CN/install.md`）换成 npm 安装。
- win32 的 `tests/process-restart.test.ts` 整文件标记原因是“AutoUpdate.takePrepared”，那条测试删了；标记留着、原因改为“待在 Windows 上复查后去掉”（标记只减不增，本机没法验证 Windows）。
