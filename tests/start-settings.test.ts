/**
 * P6-11 (ADR-156): start settings in runner.json (an autostarted Daisy has
 * no shell environment) — `port`, `acpHarnesses`, `agentBins`, precedence
 * env > runner.json > default; a broken extra ACP harness file never stops
 * a command or the start (one line each, doctor / status say so); harnesses
 * that appear later get their 「主机登录」 identity; the port rule without
 * binding (doctor, scripts/doctor.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  applyStartSettings,
  argvDataDir,
  BUILTIN_AGENT_IDS,
  readStartSettings,
  settingsEnv,
  startEnv,
  withoutFileSettings,
  withSettings,
} from "../packages/daisy/src/platform/settings.ts";
import {
  acpHarnessFromJson,
  BUILTIN_ACP_AGENTS,
  loadAcpHarnessFile,
  NATIVE_AGENTS,
} from "../packages/contracts/src/acp-harnesses.ts";
import { commandShapeOk, untrustedFile } from "../packages/contracts/src/start-files.ts";
import { chmodSync } from "node:fs";
import { childEnv } from "../packages/daisy/src/cli/local/process.ts";
import { derivedPort, expectedLocalPort } from "../packages/daisy/src/access/ports.ts";
import { writeAccessConfig } from "../packages/daisy/src/access/config.ts";
import { settingsChecks } from "../packages/daisy/src/cli/local/doctor.ts";
import { daisy, testIo } from "./cli-fixture.ts";
import type { ExecResult } from "../packages/daisy/src/cli/io.ts";

const POSIX = { skip: process.platform === "win32" ? "目录权限与 shell 脚本：POSIX 上测" : false };
const tmp = () => mkdtempSync(join(tmpdir(), "daisy-p611-"));
const writeRunner = (dir: string, v: unknown) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "runner.json"), JSON.stringify(v), { mode: 0o600 });
};
const ACME = { id: "acme", name: "Acme Agent", launch: { command: "acme", args: ["acp"] } };
/** A port nothing listens on now. */
const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => ok(p));
    });
  });
/** Everything a child must not inherit from this shell (it would change what it sees). */
const clean = (env: Record<string, string | undefined>) => {
  const out = { ...env };
  for (const k of Object.keys(out))
    // DAISY_LANG stays: these assertions read the tests' language (tests/test-env.mjs, ADR-159 §8).
    if ((/^(DAISY|HARBOR)_/.test(k) && k !== "DAISY_LANG") || k === "PORT" || k === "HOST") delete out[k];
  return out;
};

// ── runner.json → environment ───────────────────────────────────────────

test("runner.json: port, acpHarnesses (relative to the data directory), agentBins become DAISY_PORT, DAISY_ACP_HARNESSES, DAISY_<ID>_BIN", () => {
  const dir = tmp();
  try {
    writeRunner(dir, {
      nodeId: "n1",
      port: 29444,
      acpHarnesses: "acp-harnesses.json",
      agentBins: { kimi: "/opt/kimi/bin/kimi", "my-agent": "/opt/my", claude: "claude-nightly" },
    });
    const s = readStartSettings(dir);
    assert.deepEqual(s.problems, []);
    assert.deepEqual(settingsEnv(s, {}, new Set(["kimi", "claude", "my-agent"])).vars, {
      DAISY_PORT: "29444",
      DAISY_ACP_HARNESSES: join(dir, "acp-harnesses.json"),
      DAISY_KIMI_BIN: "/opt/kimi/bin/kimi",
      DAISY_MY_AGENT_BIN: "/opt/my",
      DAISY_CLAUDE_BIN: "claude-nightly",
    });
    // An absolute path stays as written.
    writeRunner(dir, { acpHarnesses: "/etc/x.json" });
    assert.equal(readStartSettings(dir).acpHarnesses, "/etc/x.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("precedence: the environment (new or old name) wins over runner.json; runner.json over the default", () => {
  const dir = tmp();
  try {
    writeRunner(dir, { port: 29444, acpHarnesses: "/a.json", agentBins: { kimi: "/file/kimi", codex: "/file/codex" } });
    const s = readStartSettings(dir);
    const env = {
      DAISY_PORT: "29555",
      DAISY_ACP_HARNESSES: "/env.json",
      DAISY_KIMI_BIN: "/env/kimi",
      HARBOR_CODEX_BIN: "/old/codex",
    };
    assert.deepEqual(settingsEnv(s, env).vars, {}, "every one set in the environment");
    // PORT (the generic one Daisy also honours) is given too.
    assert.deepEqual(settingsEnv({ agentBins: {}, problems: [], port: 1 }, { PORT: "8080" }).vars, {});
    // An empty variable is not a value.
    assert.deepEqual(settingsEnv({ agentBins: {}, problems: [], port: 29444 }, { DAISY_PORT: "" }).vars, { DAISY_PORT: "29444" });
    const merged = withSettings(dir, { DAISY_KIMI_BIN: "/env/kimi" });
    assert.equal(merged.DAISY_KIMI_BIN, "/env/kimi");
    assert.equal(merged.DAISY_CODEX_BIN, "/file/codex");
    assert.equal(merged.DAISY_PORT, "29444");
    // applyStartSettings writes only what is missing, and says what it set.
    const target: Record<string, string | undefined> = { DAISY_KIMI_BIN: "/env/kimi" };
    const r = applyStartSettings(dir, target);
    assert.deepEqual(Object.keys(r.from).sort(), ["DAISY_ACP_HARNESSES", "DAISY_CODEX_BIN", "DAISY_PORT"]);
    assert.equal(target.DAISY_KIMI_BIN, "/env/kimi");
    assert.equal(target.DAISY_CODEX_BIN, "/file/codex");
    // No runner.json: nothing, no problem.
    rmSync(join(dir, "runner.json"));
    assert.deepEqual(readStartSettings(dir), { agentBins: {}, problems: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner.json: a bad value is left out and said in one line naming the file and the key; an unreadable file never throws", () => {
  const dir = tmp();
  try {
    writeRunner(dir, { port: "29444", acpHarnesses: 3, agentBins: { kimi: "", opencode: "/ok" } });
    const s = readStartSettings(dir);
    assert.equal(s.port, undefined);
    assert.equal(s.acpHarnesses, undefined);
    assert.deepEqual(s.agentBins, { opencode: "/ok" });
    assert.equal(s.problems.length, 3, s.problems.join("\n"));
    for (const p of s.problems) {
      assert.ok(p.includes(join(dir, "runner.json")), p);
      assert.ok(!p.includes("\n"), p);
    }
    assert.ok(s.problems.some((p) => p.includes(" port ")));
    assert.ok(s.problems.some((p) => p.includes("acpHarnesses")));
    // P6-11 review L4: where it broke, never the file's text.
    writeFileSync(join(dir, "runner.json"), '{ "agentBins": SECRET_VALUE_xyz }', { mode: 0o600 });
    const broken = readStartSettings(dir);
    assert.equal(broken.problems.length, 1);
    assert.match(broken.problems[0]!, /不是合法 JSON/);
    assert.ok(!broken.problems[0]!.includes("SECRET_VALUE_xyz"), broken.problems[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command line finds the data directory as cli/main.ts does (--data-dir X, --data-dir=X; not after --)", () => {
  assert.equal(argvDataDir(["--data-dir", "/d", "status"]), resolve("/d"));
  assert.equal(argvDataDir(["status", "--data-dir=/e"]), resolve("/e"));
  assert.equal(argvDataDir(["session", "send", "x", "--", "--data-dir", "/f"]), undefined);
  assert.equal(argvDataDir(["--help"]), undefined);
  // P6-11 review L3: exactly as globals — the last one wins, the next word is
  // the value whatever it looks like, an empty one is absent (a usage error there).
  assert.equal(argvDataDir(["--data-dir", "/a", "status", "--data-dir=/b"]), resolve("/b"));
  assert.equal(argvDataDir(["--data-dir", "-x"]), resolve("-x"));
  assert.equal(argvDataDir(["--data-dir="]), undefined);
  assert.equal(argvDataDir(["--data-dir=/a", "--data-dir"]), undefined);
});

test("the command line itself uses the same --data-dir as the start settings (last wins; empty is a usage error)", async () => {
  const root = tmp();
  try {
    let r = await daisy(testIo(), join(root, "a"), "--data-dir", join(root, "b"), "status", "--json");
    assert.equal(JSON.parse(r.out).dataDir, join(root, "b"));
    r = await daisy(testIo(), join(root, "a"), "--data-dir=", "status");
    assert.equal(r.code, 2);
    assert.match(r.err, /--data-dir 后面缺少目录/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the extra ACP harness file ──────────────────────────────────────────

test("a broken extra ACP harness file adds nothing (or leaves out the broken entry) and says so in one line — it never throws", () => {
  const files: Record<string, string> = {
    "/bad-json": '[{"id":"acme"',
    "/object": '{"id":"acme"}',
    "/mixed": JSON.stringify([ACME, { id: "Bad Id", launch: { command: "x" } }, { id: "kimi", launch: { command: "x" } }, { ...ACME }]),
  };
  const read = (f: string) => {
    if (!(f in files)) throw Object.assign(new Error(`ENOENT: no such file, open '${f}'`), { code: "ENOENT" });
    return files[f]!;
  };
  let r = loadAcpHarnessFile("/bad-json", read);
  assert.deepEqual(r.entries, []);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0]!, /^ACP harness 定义文件 \/bad-json：.*不是合法 JSON，其中的 harness 都没有加载$/);
  r = loadAcpHarnessFile("/object", read);
  assert.match(r.problems[0]!, /须为 JSON 数组/);
  r = loadAcpHarnessFile("/missing", read);
  assert.match(r.problems[0]!, /\/missing：不存在/);
  r = loadAcpHarnessFile("/mixed", read);
  assert.deepEqual(r.entries.map((h) => h.id), ["acme"]);
  assert.equal(r.problems.length, 3);
  assert.match(r.problems[0]!, /第 2 项（Bad Id）：id 无效/);
  assert.match(r.problems[1]!, /第 3 项（kimi）：id 已被占用/);
  assert.match(r.problems[2]!, /第 4 项（acme）：id 重复/);
  for (const p of r.problems) assert.ok(!/[\n\r]/.test(p));
  // A control character in the file's own text cannot break the line.
  files["/nl"] = JSON.stringify([{ id: "a\nb", launch: { command: "x" } }]);
  assert.ok(!/[\n\r]/.test(loadAcpHarnessFile("/nl", read).problems[0]!));
});

const BIN = resolve("packages/daisy/bin/daisy.mjs");
const runCli = (argv: string[], env: Record<string, string | undefined>) =>
  promisify(execFile)(process.execPath, [BIN, ...argv], { env: env as NodeJS.ProcessEnv, timeout: 60_000 }).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e) => ({ code: typeof e.code === "number" ? e.code : 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }),
  );

test("a broken DAISY_ACP_HARNESSES no longer crashes `daisy`: --help and status work, one line names the file, no stack trace", POSIX, async () => {
  const root = tmp();
  try {
    const data = join(root, "data");
    const bad = join(root, "acp.json");
    writeFileSync(bad, '[{"id":"acme"');
    const env = { ...clean(process.env), HOME: root, DAISY_ACP_HARNESSES: bad };
    let r = await runCli(["--data-dir", data, "--help"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /daisy —— /);
    const lines = r.stderr.trim().split("\n");
    assert.equal(lines.length, 1, r.stderr);
    assert.match(lines[0]!, new RegExp(`^✗ ACP harness 定义文件 ${bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}：.*不是合法 JSON`));
    assert.doesNotMatch(r.stderr, /^\s+at /m, "no stack trace");
    // status: not running (3); the problem is in its own output, not repeated.
    r = await runCli(["--data-dir", data, "status", "--json"], env);
    assert.equal(r.code, 3, r.stderr);
    assert.equal(r.stderr, "");
    const info = JSON.parse(r.stdout);
    assert.equal(info.problems.length, 1);
    assert.ok(info.problems[0].includes(bad));
    r = await runCli(["--data-dir", data, "status"], env);
    assert.match(r.stdout, /设置问题 +ACP harness 定义文件/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the command line takes the harnesses named in runner.json `acpHarnesses` without the environment variable (--agent acme)", POSIX, async () => {
  const root = tmp();
  try {
    const data = join(root, "data");
    writeRunner(data, { acpHarnesses: "acp.json" });
    writeFileSync(join(data, "acp.json"), JSON.stringify([ACME]));
    const env = { ...clean(process.env), HOME: root };
    let r = await runCli(["--data-dir", data, "profile", "create-managed", "--help"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"acme"/);
    assert.equal(r.stderr, "");
    r = await runCli(["--data-dir", data, "profile", "create-managed", "--agent", "acme", "--node-id", "n", "--label", "x"], env);
    assert.doesNotMatch(r.stderr, /--agent 只能是/, "acme is accepted (it fails later: Daisy is not running)");
    assert.notEqual(r.code, 0);
    // Without it (another data directory), acme is refused as before.
    r = await runCli(["--data-dir", join(root, "other"), "profile", "create-managed", "--agent", "acme", "--node-id", "n", "--label", "x"], env);
    assert.match(r.stderr, /--agent 只能是/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── doctor ───────────────────────────────────────────────────────────────

test("doctor: runner.json's agentBins and port as the start uses them; the extra file's problems as failures with a fix", POSIX, async () => {
  const root = tmp();
  const dir = join(root, "data");
  try {
    const port = await freePort();
    writeRunner(dir, { port, acpHarnesses: "acp.json", agentBins: { claude: join(root, "fake-claude") } });
    writeFileSync(join(dir, "acp.json"), JSON.stringify([ACME, { id: "Bad Id" }]));
    writeFileSync(join(root, "fake-claude"), "#!/bin/sh\n", { mode: 0o755 });
    const exec = (cmd: string, args: string[]): ExecResult | undefined => {
      if (cmd.endsWith("fake-claude"))
        return args[0] === "--version"
          ? { code: 0, stdout: "2.1.0 (Claude Code)\n", stderr: "" }
          : { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" };
      if (cmd.includes("codex") || cmd.includes("kimi") || cmd.includes("opencode") || cmd.includes("agy") || cmd.includes("dsh"))
        return { code: 127, stdout: "", stderr: "", missing: true };
      return undefined;
    };
    const env = { ...clean(process.env), HOME: root, PATH: dirname(process.execPath) };
    const io = testIo({ env, exec, platform: "darwin" });
    // testIo merges process.env: blank out what this shell may have set.
    for (const k of Object.keys(io.env)) if ((/^(DAISY|HARBOR)_/.test(k) && k !== "DAISY_LANG") || k === "PORT") delete io.env[k];
    const r = await daisy(io, dir, "doctor");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✓ Claude Code：2\.1\.0/, "found through runner.json agentBins");
    assert.match(r.out, new RegExp(`✓ 端口：${port} 空闲（指定的）`));
    assert.match(r.out, /✗ 扩展 ACP harness：ACP harness 定义文件 .*acp\.json：第 2 项（Bad Id）：id 无效.*\n\s+怎么办：改好这个文件（来自runner\.json 的 acpHarnesses）/);
    assert.match(r.out, /✓ 扩展 ACP harness：.*acp\.json（来自runner\.json 的 acpHarnesses）：Acme Agent（acme）/);
    // The environment variable, when set, is named instead.
    const checks = settingsChecks({ io: { ...io, env: { ...io.env, DAISY_ACP_HARNESSES: join(dir, "acp.json") } }, dataDir: dir });
    assert.ok(checks.some((c) => c.level === "fail" && c.fix!.includes("环境变量 DAISY_ACP_HARNESSES")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the local port a start would try first, without binding: given (env, runner.json) > remembered > derived", () => {
  const dir = tmp();
  try {
    assert.deepEqual(expectedLocalPort(dir, {}, 501), { port: derivedPort("local", 501), source: "derived" });
    writeAccessConfig(dir, (c) => ({ ...c, ports: { ...c.ports, local: 29400 } }));
    assert.deepEqual(expectedLocalPort(dir, {}, 501), { port: 29400, source: "remembered" });
    writeRunner(dir, { port: 29450 });
    assert.deepEqual(expectedLocalPort(dir, {}, 501), { port: 29450, source: "given" });
    assert.deepEqual(expectedLocalPort(dir, { DAISY_PORT: "29460" }, 501), { port: 29460, source: "given" });
    assert.deepEqual(expectedLocalPort(dir, { PORT: "29470" }, 501), { port: 29470, source: "given" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scripts/doctor.ts asks the real local face (runtime file / Daisy's port rule), not a fixed 8787", () => {
  const text = readFileSync("scripts/doctor.ts", "utf8");
  assert.doesNotMatch(text, /8787/);
  assert.match(text, /expectedLocalPort|readRuntime|runtime\.json/);
});

// ── the Daisy process ───────────────────────────────────────────────────

test("an autostarted Daisy (no shell environment) takes runner.json's port and harnesses; a broken entry is left out, logged and in the runtime file; the new harness has its 「主机登录」 identity", POSIX, async () => {
  const root = tmp();
  const data = join(root, "data");
  const port = await freePort();
  writeRunner(data, { port, acpHarnesses: join(root, "acp.json") });
  writeFileSync(join(root, "acp.json"), JSON.stringify([ACME, { id: "kimi", launch: { command: "x" } }]));
  const child = spawn(process.execPath, ["--import", "tsx", resolve("packages/daisy/src/main.ts")], {
    env: { ...clean(process.env), HOME: root, DAISY_DATA: data, DAISY_LOCAL_RUNNER: "0" } as unknown as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  const exited = new Promise<number | null>((ok) => child.once("exit", (c) => ok(c)));
  try {
    const runtime = join(data, "runtime.json");
    for (let i = 0; i < 600 && !existsSync(runtime); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(runtime), out);
    const rt = JSON.parse(readFileSync(runtime, "utf8"));
    assert.equal(rt.local.port, port);
    assert.equal(rt.local.source, "given");
    assert.equal(rt.problems.length, 1, JSON.stringify(rt.problems));
    assert.match(rt.problems[0], /第 2 项（kimi）：id 已被占用/);
    assert.match(out, /✗ ACP harness 定义文件 .*第 2 项（kimi）/);
    // The first start's settings were kept (bootstrap merges, it does not overwrite).
    const runner = JSON.parse(readFileSync(join(data, "runner.json"), "utf8"));
    assert.equal(runner.port, port);
    assert.ok(runner.nodeId);
    const cli = readFileSync(rt.cliCredential, "utf8").trim();
    const catalog = await (await fetch(`${rt.local.url}/api/catalog`, { headers: { authorization: `Bearer ${cli}` } })).json();
    const acme = (catalog.profiles ?? []).filter((p: any) => p.agent === "acme");
    assert.equal(acme.length, 1, JSON.stringify(catalog.profiles?.map((p: any) => p.agent)));
    assert.equal(acme[0].label, "acme · 主机登录");
    // `daisy status` (in process) shows what the running Daisy found.
    const io = testIo();
    const r = await daisy(io, data, "status", "--json");
    assert.equal(r.code, 0, r.err);
    assert.ok(JSON.parse(r.out).problems.some((p: string) => p.includes("第 2 项（kimi）")));
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 20_000))]);
    rmSync(root, { recursive: true, force: true });
  }
});

// ── P6-11 review ────────────────────────────────────────────────────────

test("M1: a harness command is an absolute path or a bare name — a relative path (found in the session's workspace) is refused", () => {
  for (const ok of ["kimi", "claude-nightly", "/opt/kimi/bin/kimi", "C:\\Tools\\kimi.exe", "C:/Tools/kimi.exe", "\\\\server\\share\\kimi.exe"])
    assert.equal(commandShapeOk(ok), true, ok);
  for (const bad of ["./kimi", "bin/kimi", "../kimi", "tools\\kimi.exe", "", "a\nb"]) assert.equal(commandShapeOk(bad), false, bad);
  // runner.json agentBins: refused with a line, not applied.
  const dir = tmp();
  try {
    writeRunner(dir, { agentBins: { kimi: "./kimi", codex: "bin/codex", claude: "/opt/claude" } });
    const s = readStartSettings(dir);
    assert.deepEqual(s.agentBins, { claude: "/opt/claude" });
    assert.equal(s.problems.length, 2);
    for (const p of s.problems) assert.match(p, /agentBins\.(kimi|codex) 须为绝对路径或命令名/);
    assert.equal(withSettings(dir, {}).DAISY_KIMI_BIN, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The harness file's launch.command: the entry is refused.
  assert.throws(() => acpHarnessFromJson({ id: "acme", launch: { command: "./acme" } }), /launch\.command 须为绝对路径或命令名/);
  assert.throws(() => acpHarnessFromJson({ id: "acme", launch: { command: "bin/acme" } }), /launch\.command/);
  assert.equal(acpHarnessFromJson({ id: "acme", launch: { command: "/opt/acme" } }).launch.command, "/opt/acme");
  const r = loadAcpHarnessFile("/f", () => JSON.stringify([{ id: "acme", launch: { command: "./acme" } }, ACME]));
  assert.deepEqual(r.entries.map((h) => h.id), ["acme"]);
  assert.equal(r.entries[0]!.launch.command, "acme");
  assert.match(r.problems[0]!, /第 1 项（acme）：launch\.command 须为绝对路径或命令名/);
});

test("M1: doctor never resolves a relative command against its own directory", POSIX, async () => {
  const root = tmp();
  const cwd = process.cwd();
  try {
    mkdirSync(join(root, "rel"));
    writeFileSync(join(root, "rel", "claude"), "#!/bin/sh\n", { mode: 0o755 });
    process.chdir(root);
    const io = testIo({ env: { ...clean(process.env), HOME: root, PATH: dirname(process.execPath), DAISY_CLAUDE_BIN: "rel/claude" }, platform: "darwin", exec: () => ({ code: 127, stdout: "", stderr: "", missing: true }) });
    for (const k of Object.keys(io.env)) if (/^(DAISY|HARBOR)_/.test(k) && k !== "DAISY_CLAUDE_BIN" && k !== "DAISY_LANG") delete io.env[k];
    const r = await daisy(io, join(root, "data"), "doctor");
    assert.match(r.out, /· Claude Code：没有安装/);
    assert.ok(!io.execs.some((e) => e.cmd.includes("rel/claude")), "the planted file never ran");
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("L1: a settings file another account owns, or that others can write, is not used (runner.json and the harness file)", POSIX, () => {
  assert.equal(untrustedFile({ uid: 501, mode: 0o100600 }, 501), null);
  assert.equal(untrustedFile({ uid: 501, mode: 0o100644 }, 501), null, "readable by others is fine");
  assert.match(untrustedFile({ uid: 0, mode: 0o100600 }, 501)!, /不属于/);
  assert.match(untrustedFile({ uid: 501, mode: 0o100664 }, 501)!, /别的账户能改它（权限 0664/);
  assert.match(untrustedFile({ uid: 501, mode: 0o100606 }, 501)!, /别的账户能改它/);
  assert.equal(untrustedFile({ uid: 0, mode: 0o100666 }, undefined), null, "Windows: not judged here");
  const dir = tmp();
  try {
    writeRunner(dir, { port: 29444, agentBins: { claude: "/tmp/evil" } });
    chmodSync(join(dir, "runner.json"), 0o664);
    const s = readStartSettings(dir);
    assert.equal(s.port, undefined);
    assert.deepEqual(s.agentBins, {});
    assert.equal(s.problems.length, 1);
    assert.match(s.problems[0]!, /runner\.json 别的账户能改它.*设置都没有采用（Daisy 不按它启动）/);
    assert.deepEqual(withSettings(dir, {}), {});
    // The harness file, wherever it is named from.
    chmodSync(join(dir, "runner.json"), 0o600);
    const file = join(dir, "acp.json");
    writeFileSync(file, JSON.stringify([ACME]), { mode: 0o666 });
    chmodSync(file, 0o666);
    const r = loadAcpHarnessFile(file, (f) => readFileSync(f, "utf8"), (f) => untrustedFile(statSync(f), process.getuid!()));
    assert.deepEqual(r.entries, []);
    assert.match(r.problems[0]!, /别的账户能改它.*其中的 harness 都没有加载/);
    // …and its ids do not make agentBins keys known.
    writeRunner(dir, { acpHarnesses: "acp.json", agentBins: { acme: "/opt/acme" } });
    assert.equal(withSettings(dir, {}).DAISY_ACME_BIN, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L1: doctor does not run a command named by a runner.json others can write", POSIX, async () => {
  const root = tmp();
  const dir = join(root, "data");
  try {
    writeFileSync(join(root, "evil-claude"), "#!/bin/sh\n", { mode: 0o755 });
    writeRunner(dir, { agentBins: { claude: join(root, "evil-claude") } });
    chmodSync(join(dir, "runner.json"), 0o666);
    const io = testIo({ env: { ...clean(process.env), HOME: root, PATH: dirname(process.execPath) }, platform: "darwin", exec: () => ({ code: 127, stdout: "", stderr: "", missing: true }) });
    for (const k of Object.keys(io.env)) if (/^(DAISY|HARBOR)_/.test(k) && k !== "DAISY_LANG") delete io.env[k];
    const r = await daisy(io, dir, "doctor");
    assert.ok(!io.execs.some((e) => e.cmd.includes("evil-claude")), "never ran");
    assert.match(r.out, /✗ 启动设置：.*runner\.json 别的账户能改它/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("L2: what was taken from runner.json does not pass to the Daisy process `daisy start` launches, nor to a restart's successor", () => {
  const dir = tmp();
  try {
    writeRunner(dir, { port: 29444, agentBins: { kimi: "/file/kimi" } });
    const env: Record<string, string | undefined> = { DAISY_CODEX_BIN: "/env/codex", PATH: "/bin" };
    const r = applyStartSettings(dir, env);
    assert.deepEqual(Object.keys(r.from).sort(), ["DAISY_KIMI_BIN", "DAISY_PORT"]);
    assert.equal(env.DAISY_PORT, "29444");
    const child = childEnv({ io: testIo({ env }), dataDir: dir } as any, {});
    assert.equal(child.DAISY_PORT, undefined, "the child reads runner.json itself");
    assert.equal(child.DAISY_KIMI_BIN, undefined);
    assert.equal(child.DAISY_CODEX_BIN, "/env/codex", "the environment's own value is passed on");
    // `--port` is still given explicitly.
    assert.equal(childEnv({ io: testIo({ env }), dataDir: dir } as any, { port: 29500 }).DAISY_PORT, "29500");
    // startSuccessor's helper: a value changed since is not the file's.
    assert.deepEqual(withoutFileSettings({ DAISY_PORT: "29444", DAISY_KIMI_BIN: "/other" }, r.from), { DAISY_KIMI_BIN: "/other" });
    // Leave nothing behind for later tests in this process.
    applyStartSettings(tmp(), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L5: agentBins keys must be agents Daisy knows — built-in, or an id of the extra harness file", () => {
  assert.deepEqual([...BUILTIN_AGENT_IDS], [...NATIVE_AGENTS, ...BUILTIN_ACP_AGENTS]);
  const dir = tmp();
  try {
    writeRunner(dir, { agentBins: { nosuch: "/x", acme: "/opt/acme", kimi: "/opt/kimi" } });
    let r = startEnv(dir, {});
    assert.deepEqual(r.vars, { DAISY_KIMI_BIN: "/opt/kimi" });
    assert.equal(r.problems.length, 2);
    assert.match(r.problems.join("\n"), /agentBins\.nosuch 不是已知的 agent/);
    // acme becomes known with the harness file (runner.json's or the environment's).
    writeFileSync(join(dir, "acp.json"), JSON.stringify([ACME]), { mode: 0o600 });
    r = startEnv(dir, { DAISY_ACP_HARNESSES: join(dir, "acp.json") });
    assert.deepEqual(r.vars, { DAISY_KIMI_BIN: "/opt/kimi", DAISY_ACME_BIN: "/opt/acme" });
    assert.equal(r.problems.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── P6-13: one port rule everywhere ─────────────────────────────────────

test("P6-13: a given port is an integer 1024–65535 wherever it is given (runner.json, DAISY_PORT / PORT, --port)", () => {
  const dir = tmp();
  try {
    for (const ok of [1024, 29444, 65535]) {
      writeRunner(dir, { port: ok });
      const s = readStartSettings(dir);
      assert.equal(s.port, ok);
      assert.deepEqual(s.problems, []);
    }
    for (const bad of [0, 1, 80, 1023, 65536]) {
      writeRunner(dir, { port: bad });
      const s = readStartSettings(dir);
      assert.equal(s.port, undefined, String(bad));
      assert.equal(s.problems.length, 1);
      assert.match(s.problems[0]!, / port 须为 1024–65535 之间的整数/);
    }
    // The rule the start uses without binding (doctor): an unusable value is not "given".
    rmSync(join(dir, "runner.json"));
    assert.equal(expectedLocalPort(dir, { DAISY_PORT: "80" }, 501).source, "derived");
    assert.equal(expectedLocalPort(dir, { PORT: "70000" }, 501).source, "derived");
    assert.deepEqual(expectedLocalPort(dir, { DAISY_PORT: "1024" }, 501), { port: 1024, source: "given" });
    // "0" still means "not given": the rule picks one.
    assert.equal(expectedLocalPort(dir, { PORT: "0" }, 501).source, "derived");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P6-13: Daisy refuses to start on a DAISY_PORT outside 1024–65535, saying which variable and the range", POSIX, async () => {
  const root = tmp();
  const data = join(root, "data");
  try {
    for (const [name, value] of [["DAISY_PORT", "80"], ["DAISY_PORT", "abc"], ["PORT", "70000"]] as const) {
      const child = spawn(process.execPath, ["--import", "tsx", resolve("packages/daisy/src/main.ts")], {
        env: { ...clean(process.env), HOME: root, DAISY_DATA: data, DAISY_LOCAL_RUNNER: "0", [name]: value } as unknown as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.on("data", (b) => (out += b));
      const code = await new Promise<number | null>((ok) => child.once("exit", (c) => ok(c)));
      assert.equal(code, 1, out);
      assert.match(out, new RegExp(`${name}=${value}.*1024–65535`), out);
      assert.equal(existsSync(join(data, "runtime.json")), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P6-13: doctor fails on a DAISY_PORT the start would refuse", POSIX, async () => {
  const root = tmp();
  const dir = join(root, "data");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const exec = (): ExecResult => ({ code: 127, stdout: "", stderr: "", missing: true });
    const io = testIo({ env: { ...clean(process.env), HOME: root, PATH: dirname(process.execPath) }, exec });
    for (const k of Object.keys(io.env)) if ((/^(DAISY|HARBOR)_/.test(k) && k !== "DAISY_LANG") || k === "PORT") delete io.env[k];
    io.env.DAISY_PORT = "80";
    const r = await daisy(io, dir, "doctor");
    assert.match(r.out, /✗ 端口：DAISY_PORT=80 不是 1024–65535 之间的整数/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
