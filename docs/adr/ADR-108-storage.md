# ADR-108：存储——一个数据库文件、结构版本、升级前备份与退回

- 日期：2026-11-17
- 状态：**已实施（P1-04），待审查**
- 工作包：P1-04
- 相关：ADR-102（数据目录）、ADR-104 决定 4（`VACUUM INTO`、保留 3 份、只在结构升级时备份、只增不删）、ADR-106（单进程、`launch.sh`）；取代旧版按 `PRAGMA user_version` 逐步加列的做法

## 背景

- 改造前：数据库是数据目录下的 `harbor.sqlite`，默认数据目录是“代码根/.data”。结构分散在约 25 个模块里：`store/base.ts` 有 12 步按 `user_version` 编号的迁移，其余模块在启动或第一次用到时各自 `CREATE TABLE IF NOT EXISTS`、按需 `ALTER TABLE … ADD COLUMN`，没有统一的版本，也没有备份。
- 维护者的决定：旧版已停用，它的数据不导入，从干净的结构开始。
- 维护者的决定：自动更新在本包的备份与退回落地前默认关。

## 决定

### 1. 一个文件，放在数据目录

- 数据目录用 `packages/daisy/src/platform/paths.ts` 的 `dataDir()`（`DAISY_DATA` > 系统惯例）。**`HARBOR_DATA` 不再认**（审查修订）：P1-02 的 `launch.sh` 把它设成启动器旁的 `data/`（那里是旧的 `harbor.sqlite`），自动更新切换时用的还是旧启动器，认它就会每次被拒、守卫回滚、循环；设了时启动打一行提示。开发检出（代码根有 `.git`、没有 `.release`）没设 `DAISY_DATA` 时用 `<代码根>/.data`（`startDataDir()`，启动时打一行提示），npm 装的包和发布目录不受影响。数据目录落在发布目录里面（`realpathSync.native` 比较）时拒绝启动。
- 同一数据目录只允许一个 Daisy（ADR-102 决定 4）：`packages/daisy/src/store/data-lock.ts`，数据目录里的 `daisy.lock`（进程号 + 进程启动时间，0600）。第二个进程拒绝启动并说出谁占着；进程已不在、或进程号被别的进程复用（启动时间不同）、或文件是半截的，算陈旧锁，原子地挪开后接管。拿锁之前先检查旧库（不写任何东西）。
- Runner 的状态（结果日志、身份目录、插件状态）默认放在数据目录的 `runner/` 下（`runner.json` 没写 `identityRoot` 时由 `main.ts` 填）。
- `scripts/runner-launch.sh` 不再导出 `HARBOR_DATA=<启动器旁>/data`：进程用系统惯例的位置。P1-02 时期放在启动器旁的 `data/` 不再使用、不导入，原样保留（启动器打一行提示）。
- 数据库文件名 `daisy.sqlite`（ADR-102 的布局），WAL 模式。

### 2. 只有主人可读

- `store/open.ts` 的 `restrictToOwner()`：目录 0700，文件 0600。数据库文件在 SQLite 打开前就以 0600 建出（SQLite 让 `-wal`、`-shm` 沿用主文件的权限）；已有的目录、数据库及 `-wal` / `-shm`、`master.key`、`ACCESS.md`、`runner.json`、`RECOVERY.md`、`backups/` 与其中的备份、`attachments/` 与其中的文件每次启动收紧一次。恢复中途被杀留下的 `daisy.sqlite.restore` 启动时删掉。备份目录 0700、备份文件先以 0600 建空文件再 `VACUUM INTO`。
- Windows：按平台分支，`restrictToOwner()` 在 Windows 上不动、返回 false，`ownerOnly()` 返回“无法判断”；ACL 的做法在 P5-05 落实（ADR-099），测试标为“尚未支持”。

### 3. 干净的起点与旧数据库

- 结构只写在 `packages/daisy/src/store/schema.ts`：`MIGRATIONS` 是编号连续的步骤，**第 1 步 = 完整结构**（改造前全部模块建出的表、列、索引，逐列核对过：列的顺序、类型、默认值、索引的条件都和改造前一致）。其余模块里的建表、加列代码全部删除（测试保证控制面里 `store/schema.ts` 之外没有建表 / 改表语句）。
- Daisy 的数据库用 `PRAGMA application_id = 0x44616973`（"Dais"）标记，结构版本记在 `PRAGMA user_version`，每一步另记一行 `schema_migrations(version, applied_at, readable_from, note)`。
- 遇到旧数据库，**拒绝启动、不写任何东西**（不建目录、不改权限、不留 `-wal` / `-shm`）：数据目录里有 `harbor.sqlite`，或者 `daisy.sqlite` 不是 Daisy 标记的非空数据库。检查在建目录、收紧权限之前，直接读文件头（0–15 格式标识、40 结构计数、60 `user_version`、68 `application_id`）；只有旁边已有 `-wal`（文件头可能比日志旧）时才只读打开，并删掉这次打开新建的 `-wal` / `-shm`。提示：“旧系统的数据库不导入……请用新的数据目录：设置 DAISY_DATA 指向一个新的空目录，或者不设……旧目录可以留作只读存档。”

### 4. 升级：先备份，一个事务，失败退回

- 代码的结构版本高于文件时：
  1. `VACUUM INTO backups/daisy-schema<旧>-to<新>-<UTC 时间>.sqlite`（WAL 下也是一致快照，不停服务），只读打开核对结构版本；备份写不成就**不升级**、数据库不动、拒绝启动并说明。
  2. 所有待做的步骤在**一个** `BEGIN IMMEDIATE` 事务里执行（SQLite 的 DDL 在事务内），每步写 `schema_migrations`、`user_version`；全部成功才提交。
  3. 任何一步出错：回滚；再比对回滚后的结构指纹（`user_version` + 全部对象的 SQL；只比结构，行的撤销由同一个 ROLLBACK 保证）与升级前是否一致。一致就说明“整个升级已回滚，结构没有改动”，并删掉这次刚做的备份（它和现在的文件一样，反复失败不能挤掉有用的备份）；不一致（例如某一步自己提交了）就关库、删 `-wal` / `-shm`、用刚才的备份替换文件并核对。随后进程拒绝启动，信息里写：从第几版升到第几版、哪一步、什么错、退回的结果、备份在哪、怎么办（换回上一版；自动更新时守卫会切回）。
- 只在结构要升级时备份；新建的库不备份。旧备份只在升级提交成功之后才清理，保留最新 3 份（`STORAGE.keepBackups`，存储的设置集中在 `store/open.ts` 的 `STORAGE`），按文件名里的时间删旧的，只删符合 Daisy 备份命名的文件。

### 5. 代码回退与数据库

- 规则：**结构只增不删**——只加表、加可空或带默认值的列、加索引 / 触发器；不删、不改名表 / 列 / 视图；不给被旧代码按位置 `INSERT … VALUES` 写入的表加列（`tests/schema-compat.test.ts` 冻结了这些表的列数）。所以 `launch.sh` 的守卫把代码切回上一版时，上一版**照常使用更新过的库，不降级、不恢复、不备份**（启动时打一行“结构比这一版新，照常使用”）。
- 例外：确实需要删 / 改名时（只应出现在主版本），这一步写 `breaking: "<理由>"`。它执行后 `schema_migrations.readable_from` 记为这一步的版本；比它旧的代码打开这个库时**拒绝启动、不改动文件**，提示：换回新版本，或者停掉 Daisy、用 `backups/` 里这一步之前的备份替换 `daisy.sqlite`（并删掉 `-wal`、`-shm`），备份之后的数据会丢失。守卫在确认期内自动恢复备份（ADR-104 决定 4 的后半）等第一个不兼容步骤出现时再做；现在一个都没有。
- 没有 `breaking` 而出现 `DROP TABLE` / `DROP COLUMN` / `DROP VIEW` / `RENAME` 的步骤：测试失败，代码也拒绝执行（`destructiveStatements()`）。`DROP INDEX` / `DROP TRIGGER` 只允许在同一步里重建同名的。
- 第 1 步冻结：测试比对它的 SHA-256。之后的结构变更追加第 2、3……步（P1-05 的 PIN 表是第 2 步）。

### 6. 自动更新

备份与退回落地，`packages/daisy/src/turns/worker.ts` 的自动更新改回团队内部默认开（`runner.json` 的 `autoUpdate: false` 关掉）。

## 没有照原计划做的地方

- **Runner 的结果日志仍是另一个 SQLite 文件**（`packages/daisy/src/turns/result-journal.ts` 的 `results.sqlite`）。它已经在数据目录里（`runner/result-journal/…`，审查修订），所以“一个数据目录、卸载不留”成立；合并进 `daisy.sqlite` 要改 Runner 的恢复路径和对账，留给 P1-02b（搬家）或 P1-09（安装）。在那之前“一个数据库文件”对控制面成立、对整个进程不完全成立。
  - **P1-02b 已做**：结构第 5 步加 `runner_journal_jobs`、`runner_journal_events`（按节点区分，行和原文件一样）、`runner_journal_imports`；Runner 用控制面的同一个连接（`runnerApi(nodeId).journal`）。升级后第一次启动，`runNode` 在任何工作之前把旧的 `results.sqlite` 导入一次（一个事务，记在 `runner_journal_imports`，不会导入两次），再改名为 `results.sqlite.migrated`（连同可能剩下的 -wal / -shm），不删除；读不了就不启动 Runner（证据不能悄悄丢）。现在“一个数据库文件”对整个进程成立，备份（VACUUM INTO）带上结果日志。
- 插件（私有插件的适配包）在同一个库里建自己的表，沿用“只增”的写法，不进 `MIGRATIONS`、不触发备份。测试只检查插件代码里没有删除 / 改名语句。
- `packages/daisy/src/_phase4/` 里阶段 4 的参考代码仍各自建表；它没有接入，阶段 4 接入时要把表搬进新的编号步骤。
- 备份文件名用结构版本，不带代码版本（ADR-104 写的是 `daisy-<旧版本>-schema<旧结构版本>-<时间>`）：存储层不知道代码版本，而退回只看结构版本。

## 后果

- 新的结构变更只有一个去处，评审时一眼能看到“这次加了什么”。代价：P1-03（删账号 / 节点）和 P1-05（PIN）都要按这个机制写：加东西是追加一步；删表在第 1 步冻结后只能留着不用，或者在主版本里写 `breaking`。若 P1-03 在任何人用第 1 步建库之前合入，可以直接改第 1 步并更新测试里的哈希（提交说明写明）。
- 旧代码与新库：只增不删的前提下，回退代码永远不需要动数据库。
- 测试见 `tests/storage.test.ts`（升级前备份与失败退回、文件只有主人可读、旧库不导入、代码回退）和 `tests/schema-compat.test.ts`（只增不删、第 1 步冻结、没有散落的建表语句）。
