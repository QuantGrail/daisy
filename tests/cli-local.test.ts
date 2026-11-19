/**
 * P1-07 / P1-09: the local commands, each in a temporary data directory
 * (DAISY_DATA / --data-dir). start / status / stop / uninstall run the real
 * Daisy process (without its Runner); open / update talk to a stand-in;
 * autostart and uninstall drive a fake `systemctl` (the unit file itself is
 * real, written under a temporary XDG_CONFIG_HOME).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daisy, fakeDaisy, testIo } from "./cli-fixture.ts";
import type { ExecResult } from "../packages/daisy/src/cli/io.ts";
import { pidAlive } from "../packages/daisy/src/cli/daisy.ts";
import {
  sdQuote,
  servicePath,
  unitName,
  unitText,
} from "../packages/daisy/src/platform/autostart.ts";
import { dataDir as conventional } from "../packages/daisy/src/platform/paths.ts";
import { SERVER_MAIN } from "../packages/daisy/src/cli/code.ts";

const ENV = { DAISY_LOCAL_RUNNER: "0" };
/**
 * Windows: stopping is SIGTERM, which Windows turns into an immediate kill
 * (no 收尾), and data-directory modes are ACLs there — both are P5-05's.
 */
const POSIX = { skip: process.platform === "win32" ? "尚未支持（P5-05）：Windows 上的停止与目录权限" : false };
const tmp = () => mkdtempSync(join(tmpdir(), "daisy-local-"));

/** A fake systemd user manager: units by name, a record of the calls. */
function fakeSystemd(o: { available?: boolean; linger?: boolean } = {}) {
  const state = new Map<string, { enabled: boolean; active: boolean }>();
  const calls: string[] = [];
  const exec = (cmd: string, args: string[]): ExecResult | undefined => {
    if (cmd === "loginctl") return { code: 0, stdout: o.linger ? "yes\n" : "no\n", stderr: "" };
    if (cmd !== "systemctl") return undefined;
    calls.push(args.join(" "));
    if (o.available === false) return { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" };
    const [, verb, ...rest] = args;
    const unit = rest.at(-1)!;
    const u = state.get(unit) ?? { enabled: false, active: false };
    switch (verb) {
      case "show-environment":
      case "daemon-reload":
        return { code: 0, stdout: "", stderr: "" };
      case "enable":
        state.set(unit, { ...u, enabled: true });
        return { code: 0, stdout: "", stderr: `Created symlink ${unit}` };
      case "disable":
        state.set(unit, { ...u, enabled: false });
        return { code: 0, stdout: "", stderr: u.enabled ? `Removed ${unit}` : "" };
      case "is-enabled":
        return { code: u.enabled ? 0 : 1, stdout: u.enabled ? "enabled\n" : "disabled\n", stderr: "" };
      case "is-active":
        return { code: u.active ? 0 : 3, stdout: u.active ? "active\n" : "inactive\n", stderr: "" };
      case "show":
        return { code: 0, stdout: "0\n", stderr: "" };
      case "start":
      case "stop":
        state.set(unit, { ...u, active: verb === "start" });
        return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unknown verb ${verb}` };
  };
  return { exec, calls, state };
}

test("start → already running → status → stop → stop again: the real process, a temporary data directory", POSIX, async () => {
  const root = tmp();
  const dir = join(root, "data");
  try {
    let io = testIo({ env: ENV });
    let r = await daisy(io, dir, "status");
    assert.equal(r.code, 3, "not running");
    assert.match(r.out, /Daisy 没在运行/);
    assert.match(r.out, /daisy start/);

    io = testIo({ env: ENV });
    r = await daisy(io, dir, "start");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Daisy 已启动：http:\/\/127\.0\.0\.1:\d+/);
    assert.ok(r.out.includes(dir), "says where the data is");
    const rt = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8"));
    assert.ok(pidAlive(rt.pid));
    assert.ok(existsSync(join(dir, "logs", "daisy.log")), "its output goes to the log");
    // P5-04: the data directory is the owner's alone on macOS as on Linux —
    // every folder 0700 (or tighter), every file without group / other bits.
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const p = join(d, e.name);
        return e.isDirectory() ? [p, ...walk(p)] : e.isSymbolicLink() ? [] : [p];
      });
    for (const p of [dir, ...walk(dir)])
      assert.equal(statSync(p).mode & 0o077, 0, `${p} is ${(statSync(p).mode & 0o777).toString(8)}`);

    io = testIo({ env: ENV });
    r = await daisy(io, dir, "start");
    assert.equal(r.code, 0, "already running is not an error");
    assert.match(r.out, /已经在运行.*进程号 \d+/);

    io = testIo({ env: ENV });
    r = await daisy(io, dir, "status");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Daisy 正在运行（进程号 \d+/);
    assert.match(r.out, /本机面\s+http:\/\/127\.0\.0\.1:\d+/);
    assert.match(r.out, /对外面\s+未开启/);
    assert.match(r.out, /PIN\s+/);
    assert.match(r.out, /更新\s+/);
    io = testIo({ env: ENV });
    r = await daisy(io, dir, "status", "--json");
    const j = JSON.parse(r.out);
    assert.equal(j.running, true);
    assert.equal(j.dataDir, dir);
    assert.equal(j.pid, rt.pid);

    // A generated command against the real process: the credential works.
    io = testIo({ env: ENV });
    r = await daisy(io, dir, "whoami");
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).channel, "cli");

    io = testIo({ env: ENV });
    r = await daisy(io, dir, "stop");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /已停止/);
    assert.equal(pidAlive(rt.pid), false);
    assert.equal(existsSync(join(dir, "runtime.json")), false, "it removed its runtime file");

    io = testIo({ env: ENV });
    r = await daisy(io, dir, "stop");
    assert.equal(r.code, 0);
    assert.match(r.out, /本来就没在运行/);
    // The data directory stays, private.
    assert.ok(existsSync(join(dir, "keys", "cli-credential")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a start that fails says why (from the log) and how to fix it", POSIX, async () => {
  const root = tmp();
  const dir = join(root, "data");
  try {
    // A port given that is taken → Daisy refuses rather than moving.
    const net = await import("node:net");
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as any).port;
    // Below 1024 is refused by the command itself.
    let r = await daisy(testIo({ env: ENV }), dir, "start", "--port", "80");
    assert.equal(r.code, 2);
    assert.match(r.err, /1024–65535/);
    r = await daisy(testIo({ env: ENV }), dir, "start", "--port", String(port));
    s.close();
    if (port < 1024) return;
    assert.equal(r.code, 1);
    assert.match(r.err, /启动后马上退出了[\s\S]*已被占用[\s\S]*怎么办：/);
    assert.equal(existsSync(join(dir, "runtime.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale runtime file (the process died) reads as not running", async () => {
  const d = await fakeDaisy();
  try {
    const rt = JSON.parse(readFileSync(join(d.dataDir, "runtime.json"), "utf8"));
    rt.pid = 2 ** 22 + 4242;
    writeFileSync(join(d.dataDir, "runtime.json"), JSON.stringify(rt));
    let r = await daisy(testIo(), d.dataDir, "status");
    assert.equal(r.code, 3);
    assert.match(r.out, /上次没有正常退出/);
    r = await daisy(testIo(), d.dataDir, "stop");
    assert.equal(r.code, 0);
    assert.match(r.out, /已经不在了/);
  } finally {
    await d.close();
  }
});

test("status: PIN not set is said loudly; unavailable on a Daisy without PIN routes", async () => {
  let pin: unknown = { set: false, lockedUntil: null };
  const d = await fakeDaisy((r) =>
    r.path === "/api/pin" ? (pin ? { json: pin } : { status: 404, json: { error: "Not Found" } }) : r.path === "/api/access" ? { json: { external: { enabled: false, listening: false }, passcode: { mode: "auto", effective: true, sharedHost: true } } } : r.path === "/api/update" ? { json: { supervised: false, update: null, request: null, summary: "没有" } } : r.path === "/api/catalog" ? { json: { nodes: [{ capabilities: { runner: { autoUpdate: { state: "disabled" } } } }] } } : undefined,
  );
  try {
    let r = await daisy(testIo(), d.dataDir, "status");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /PIN\s+未设置/);
    assert.match(r.out, /⚠ 还没有设置 PIN：先运行 daisy pin set，否则 AI 不会开始工作/);
    assert.match(r.out, /网页口令\s+auto：生效/);
    assert.match(r.out, /自动更新\s+关闭（runner\.json autoUpdate: false/);
    // P5-06: only a Daisy in the foreground does not restart itself (a
    // background process `daisy start` ran starts its successor).
    assert.match(r.out, /更新\s+前台运行：装了新版本不会自己换上/);
    pin = { set: true, lockedUntil: null };
    r = await daisy(testIo(), d.dataDir, "status");
    assert.match(r.out, /PIN\s+已设置/);
    assert.doesNotMatch(r.out, /⚠/);
    pin = null;
    r = await daisy(testIo(), d.dataDir, "status");
    assert.match(r.out, /PIN\s+这个版本还没有 PIN 功能/);
  } finally {
    await d.close();
  }
});

test("open: asks Daisy for a one-time code, opens or prints the link; --external needs the PIN", async () => {
  const d = await fakeDaisy((r) => {
    if (r.path === "/api/web/open-code") return { json: { code: "c1", url: "http://127.0.0.1:1/#code=c1", expiresAt: 0 } };
    if (r.path === "/api/pin/grant") return { json: { grant: "g1", expiresAt: 0 } };
    if (r.path === "/api/web/open-code/external")
      return r.headers["daisy-pin-grant"] === "g1"
        ? { json: { code: "c2", url: "https://10.0.0.5:29600/#code=c2", expiresAt: 0 } }
        : { status: 403, json: { error: "要 PIN", code: "pin_required" } };
    if (r.path === "/api/pin") return { json: { set: true, lockedUntil: null } };
    return undefined;
  });
  try {
    let io = testIo({ env: { DISPLAY: ":0", SSH_CONNECTION: "", SSH_TTY: "" } });
    let r = await daisy(io, d.dataDir, "open");
    assert.equal(r.code, 0, r.err);
    assert.equal(d.requests[0]!.method, "POST");
    assert.equal(d.requests[0]!.path, "/api/web/open-code");
    assert.deepEqual(io.opened, ["http://127.0.0.1:1/#code=c1"]);
    assert.match(r.out, /#code=c1/);

    io = testIo({ env: { DISPLAY: ":0", SSH_CONNECTION: "" } });
    r = await daisy(io, d.dataDir, "open", "--print");
    assert.deepEqual(io.opened, [], "--print only prints");

    // Over SSH: printed, with how to reach it from one's own computer.
    io = testIo({ env: { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" } });
    r = await daisy(io, d.dataDir, "open");
    assert.deepEqual(io.opened, []);
    assert.match(r.out, /ssh -N -L \d+:127\.0\.0\.1:\d+/);

    io = testIo({ input: ["135790"] });
    r = await daisy(io, d.dataDir, "open", "--external");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /https:\/\/10\.0\.0\.5:29600\/#code=c2/);
    assert.ok(!io.seen().includes("135790"));
    assert.ok(d.requests.some((x) => x.path === "/api/pin/grant" && x.body.pin === "135790"));
  } finally {
    await d.close();
  }
});

test("update: shows versions and what an update waits for; --apply / --now (confirmed) / --cancel", async () => {
  let interrupted = false;
  const d = await fakeDaisy((r) => {
    if (r.path === "/api/update")
      return {
        json: {
          release: "0.1.0+old",
          supervised: true,
          update: { kind: "release", target: "0.1.0+new", since: 0 },
          request: null,
          summary: "1 个会话正在执行的一轮",
        },
      };
    if (r.path === "/api/update/restart" && r.method === "POST") {
      if (r.body.mode === "idle") return { json: { request: { mode: "idle" }, waitingFor: [{ kind: "turn" }] } };
      if (r.body.confirm === "tok") {
        interrupted = true;
        return { json: { request: { mode: "now" }, interrupts: [] } };
      }
      return {
        status: 409,
        json: {
          error: "立即重启会打断 1 个会话",
          code: "restart_interrupts",
          interrupts: [{ kind: "turn", session: { title: "写报告" } }],
          confirm: "tok",
        },
      };
    }
    if (r.path === "/api/update/restart" && r.method === "DELETE") return { json: { ok: true, cancelled: true } };
    if (r.path === "/api/catalog") return { json: { nodes: [{ capabilities: { runner: { autoUpdate: { state: "disabled" } } } }] } };
    return undefined;
  });
  try {
    let r = await daisy(testIo(), d.dataDir, "update");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /正在运行的版本：0\.1\.0\+old/);
    assert.match(r.out, /等着换上：0\.1\.0\+new/);
    assert.match(r.out, /在等：1 个会话正在执行的一轮/);
    assert.match(r.out, /自动更新：关闭/);
    r = await daisy(testIo(), d.dataDir, "update", "--apply");
    assert.match(r.out, /等空闲后重启/);
    assert.deepEqual(d.requests.at(-1)!.body, { mode: "idle" });
    // --now: the list first; not confirmed → nothing.
    r = await daisy(testIo({ input: ["no"] }), d.dataDir, "update", "--now");
    assert.equal(r.code, 1);
    assert.match(r.out, /写报告/);
    assert.equal(interrupted, false);
    r = await daisy(testIo({ input: ["yes"] }), d.dataDir, "update", "--now");
    assert.equal(r.code, 0, r.err);
    assert.equal(interrupted, true);
    r = await daisy(testIo(), d.dataDir, "update", "--cancel");
    assert.match(r.out, /已撤回/);
    r = await daisy(testIo(), d.dataDir, "update", "--apply", "--now");
    assert.equal(r.code, 2);
  } finally {
    await d.close();
  }
});

test("doctor: read-only checks with a fix for each problem; exit 1 on a failure", POSIX, async () => {
  const root = tmp();
  const dir = join(root, "data");
  mkdirSync(join(dir, "keys"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "keys", "cli-credential"), "dcli_x\n", { mode: 0o600 });
  try {
    const exec = (cmd: string, args: string[]): ExecResult | undefined => {
      if (cmd.endsWith("fake-claude"))
        return args[0] === "--version"
          ? { code: 0, stdout: "2.1.0 (Claude Code)\n", stderr: "" }
          : { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.com" }), stderr: "" };
      if (cmd.endsWith("fake-codex"))
        return args[0] === "--version"
          ? { code: 0, stdout: "codex-cli 0.1\n", stderr: "" }
          : { code: 1, stdout: "Not logged in\n", stderr: "" };
      return undefined;
    };
    for (const n of ["fake-claude", "fake-codex"]) {
      writeFileSync(join(root, n), "#!/bin/sh\n", { mode: 0o755 });
    }
    const env = {
      DAISY_CLAUDE_BIN: join(root, "fake-claude"),
      DAISY_CODEX_BIN: join(root, "fake-codex"),
      DAISY_KIMI_BIN: join(root, "no-such-kimi"),
    };
    let io = testIo({ env, exec, platform: "darwin" });
    let r = await daisy(io, dir, "doctor");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✓ Node\.js：v\d+/);
    assert.match(r.out, /✓ 数据目录：.*0700/);
    assert.match(r.out, /✓ Claude Code：2\.1\.0.*本机已登录（订阅）/);
    assert.match(r.out, /! Codex：.*本机没有登录\n\s+怎么办：在网页里登录/);
    // P4-10: the product is Kimi Code CLI (the old Kimi CLI is archived).
    assert.match(r.out, /· Kimi Code CLI：没有安装/);
    // P5-04: macOS has launchd (the test's io never runs the real launchctl: "not installed").
    assert.match(r.out, /开机自启：这台 Mac 上找不到 launchctl/);
    assert.ok(!io.seen().includes("someone@example.com"), "nothing of the harness's account is printed");
    // Only the harnesses' own status commands ran — nothing that logs in or changes.
    for (const e of io.execs.filter((x) => x.cmd.includes("fake-")))
      assert.ok(["--version", "auth", "login"].includes(e.args[0]!) && !e.args.includes("logout"), e.args.join(" "));
    assert.ok(io.execs.every((e) => !(e.args[0] === "login" && e.args[1] !== "status")));

    chmodSync(dir, 0o755);
    io = testIo({ env, exec, platform: "darwin" });
    r = await daisy(io, dir, "doctor");
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ 数据目录：.*0755.*别的账户能进去\n\s+怎么办：chmod 700/);
    io = testIo({ env, exec, platform: "darwin" });
    r = await daisy(io, dir, "doctor", "--json");
    const checks = JSON.parse(r.out);
    assert.ok(checks.some((c: any) => c.name === "数据目录" && c.level === "fail"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── autostart (P1-09) ───────────────────────────────────────────────────

test("autostart on (Linux): a user unit is written, reloaded and enabled — no root; off disables and deletes it", async () => {
  const root = tmp();
  const dir = join(root, "data");
  const sd = fakeSystemd({ linger: false });
  const env = { ...ENV, XDG_CONFIG_HOME: join(root, "config"), PATH: "/opt/node/bin:/home/u/.local/bin:relative/bin" };
  try {
    let io = testIo({ env, exec: sd.exec, platform: "linux" });
    let r = await daisy(io, dir, "autostart", "on");
    assert.equal(r.code, 0, r.err);
    const unit = unitName(dir, { ...env, DAISY_DATA: dir });
    assert.match(unit, /^daisy-[0-9a-f]{8}\.service$/, "an explicit data directory gets its own unit");
    const file = join(root, "config", "systemd", "user", unit);
    const text = readFileSync(file, "utf8");
    assert.match(text, /^\[Unit\]$/m);
    assert.match(text, /^Type=simple$/m);
    assert.ok(text.includes(sdQuote(SERVER_MAIN)), "runs the Daisy process itself");
    const exec = text.split("\n").find((l) => l.startsWith("ExecStart="))!;
    assert.ok(exec.startsWith(`ExecStart=${sdQuote(process.execPath)} --import `), exec);
    assert.ok(exec.endsWith(sdQuote(SERVER_MAIN)), exec);
    assert.match(text, /^Environment="?DAISY_DATA=.*data"?$/m);
    assert.match(text, /^Environment="?PATH=[^"\n]*\/home\/u\/\.local\/bin/m);
    assert.doesNotMatch(text, /relative\/bin/, "only absolute PATH entries");
    assert.match(text, /^Restart=on-failure$/m);
    assert.match(text, /^RestartForceExitStatus=75$/m);
    assert.match(text, /^KillMode=mixed$/m);
    assert.match(text, /^UMask=0077$/m);
    assert.match(text, /^WantedBy=default\.target$/m);
    assert.doesNotMatch(text, /DAISY_PORT|HOST=|^User=/m, "no port, no host, no user (ADR-102)");
    assert.ok(sd.calls.includes("--user daemon-reload"));
    assert.ok(sd.calls.includes(`--user enable ${unit}`));
    assert.ok(sd.calls.every((c) => c.startsWith("--user ")), "only the user manager");
    assert.ok(io.execs.every((e) => e.cmd !== "sudo"), "never root");
    assert.match(r.out, /loginctl enable-linger/, "says how to start without logging in");

    io = testIo({ env, exec: sd.exec, platform: "linux" });
    r = await daisy(io, dir, "autostart");
    assert.match(r.out, /开机自启：已开启/);

    io = testIo({ env, exec: sd.exec, platform: "linux" });
    r = await daisy(io, dir, "autostart", "off");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /已关闭/);
    assert.equal(existsSync(file), false, "the unit file is deleted");
    assert.equal(sd.state.get(unit)!.enabled, false);
    assert.ok(sd.calls.includes(`--user disable ${unit}`));

    io = testIo({ env, exec: sd.exec, platform: "linux" });
    r = await daisy(io, dir, "autostart", "off");
    assert.match(r.out, /本来就没开/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("autostart: Windows without its helper, a Mac without launchctl and no systemd user bus say how to get one", async () => {
  for (const [platform, re] of [
    ["darwin", /这台 Mac 上找不到 launchctl/],
    // P5-05: the Run entry runs Daisy's helper; none (here: no "daisy-win") → said so.
    ["win32", /Windows 辅助程序不可用/],
  ] as const) {
    const io = testIo({ platform });
    const r = await daisy(io, "/tmp/daisy-none", "autostart", "on");
    assert.equal(r.code, 1);
    assert.match(r.err, re);
    assert.match(r.err, /怎么办：/);
  }
  const io = testIo({ platform: "linux", exec: fakeSystemd({ available: false }).exec, env: { XDG_CONFIG_HOME: "/nonexistent" } });
  const r = await daisy(io, "/tmp/daisy-none", "autostart", "on");
  assert.equal(r.code, 1);
  assert.match(r.err, /连不上你的 systemd 用户实例[\s\S]*怎么办：.*XDG_RUNTIME_DIR/);
  assert.equal(existsSync("/nonexistent/systemd"), false);
});

test("unit text: names, quoting, the default data directory gets daisy.service and no DAISY_DATA", () => {
  const env = { HOME: "/home/u", XDG_DATA_HOME: undefined } as Record<string, string | undefined>;
  const dflt = conventional({ HOME: "/home/u" }, "linux", "/home/u");
  assert.equal(unitName(dflt, env, "linux"), "daisy.service");
  assert.match(unitName("/srv/other", env, "linux"), /^daisy-[0-9a-f]{8}\.service$/);
  assert.equal(sdQuote("/usr/bin/node"), "/usr/bin/node");
  assert.equal(sdQuote("/a b/n"), '"/a b/n"');
  assert.equal(sdQuote("/x%y$z"), '"/x%%y$$z"');
  assert.throws(() => sdQuote("/a\nb"));
  const t = unitText({ dataDir: dflt, explicitDataDir: false, node: "/n/node", args: ["--import", "file:///t/tsx.mjs", "/c/main.ts"], cwd: "/c", path: servicePath({ PATH: "/u/bin" }, "/n/node") });
  assert.doesNotMatch(t, /DAISY_DATA/);
  assert.match(t, /^Environment=PATH=\/n:\/u\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin$/m);
  assert.match(t, /^WorkingDirectory=\/c$/m);
});

test("uninstall (I-3): stops Daisy, removes the start-at-boot unit, keeps the data directory and says where it is", POSIX, async () => {
  const root = tmp();
  const dir = join(root, "data");
  const sd = fakeSystemd({ linger: true });
  const env = { ...ENV, XDG_CONFIG_HOME: join(root, "config") };
  try {
    // Running (a detached process) with start at boot on.
    let io = testIo({ env, exec: sd.exec, platform: "linux" });
    let r = await daisy(io, dir, "autostart", "on");
    assert.equal(r.code, 0, r.err);
    // The unit is installed, so a Linux start would go through systemd;
    // start this one as a plain process (the fake manager runs nothing).
    io = testIo({ env, exec: sd.exec, platform: "darwin" });
    r = await daisy(io, dir, "start");
    assert.equal(r.code, 0, r.err);
    const pid = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")).pid;
    assert.ok(pidAlive(pid));

    // Not confirmed: nothing happens.
    io = testIo({ env, exec: sd.exec, platform: "linux", input: ["no"] });
    r = await daisy(io, dir, "uninstall");
    assert.equal(r.code, 1);
    assert.ok(pidAlive(pid));

    io = testIo({ env, exec: sd.exec, platform: "linux" });
    r = await daisy(io, dir, "uninstall", "--yes");
    assert.equal(r.code, 0, r.err + r.out);
    // No process left.
    assert.equal(pidAlive(pid), false, "no background process");
    // No start-at-boot item left.
    const units = join(root, "config", "systemd", "user");
    assert.deepEqual(existsSync(units) ? readdirSync(units).filter((f) => f.startsWith("daisy")) : [], []);
    assert.ok([...sd.state.values()].every((u) => !u.enabled && !u.active));
    // The data directory stays, and the owner is told where.
    assert.ok(existsSync(join(dir, "keys", "cli-credential")));
    assert.ok(readdirSync(dir).length > 0);
    assert.ok(r.out.includes(`数据目录保留在：${dir}`));
    assert.match(r.out, /npm uninstall -g @daisy-ai\/daisy/);
    assert.match(r.out, /rm -rf/);

    // Again: nothing to do, still fine.
    io = testIo({ env, exec: sd.exec, platform: "linux" });
    r = await daisy(io, dir, "uninstall", "--yes");
    assert.equal(r.code, 0);
    assert.match(r.out, /Daisy 没在运行/);
    assert.match(r.out, /没有开机自启项/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("settings.autostartStatus / autostartSet (the web page): the same unit as `daisy autostart`; Windows without its helper (and a Mac without launchctl) answer supported: false", async () => {
  const { createApp } = await import("../packages/daisy/src/app.ts");
  const root = tmp();
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  const sd = fakeSystemd({ linger: false });
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), DAISY_DATA: dir };
  const host = { env, platform: "linux" as NodeJS.Platform, exec: async (cmd: string, args: readonly string[]) => sd.exec(cmd, [...args]) ?? { code: 127, stdout: "", stderr: "", missing: true } };
  const ctx = await createApp({ dataDir: dir, workspaceHome: root, workspaceRoots: [root], autostartHost: host });
  try {
    const h = { authorization: `Bearer ${ctx.issueToken()}` };
    let r = await ctx.app.inject({ url: "/api/autostart", headers: h });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { supported: true, enabled: false, manager: "systemd-user", unit: unitName(dir, env), linger: false });
    r = await ctx.app.inject({ method: "PUT", url: "/api/autostart", headers: h, payload: { enabled: true } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().enabled, true);
    assert.match(r.json().hint, /loginctl enable-linger/);
    const file = join(root, "config", "systemd", "user", unitName(dir, env));
    assert.ok(existsSync(file), "the unit `daisy autostart on` would write");
    // The command line sees the web page's change, and the reverse.
    let io = testIo({ env, exec: sd.exec, platform: "linux" });
    let c = await daisy(io, dir, "autostart");
    assert.match(c.out, /开机自启：已开启/);
    io = testIo({ env, exec: sd.exec, platform: "linux" });
    c = await daisy(io, dir, "autostart", "off");
    assert.equal(c.code, 0, c.err);
    r = await ctx.app.inject({ url: "/api/autostart", headers: h });
    assert.equal(r.json().enabled, false);
    r = await ctx.app.inject({ method: "PUT", url: "/api/autostart", headers: h, payload: { enabled: "yes" } });
    assert.equal(r.statusCode, 400);
    // Not the command line's credential only: the AI cannot (no aiSelf), checked by tests/access.test.ts.
  } finally {
    await ctx.app.close();
  }
  for (const [platform, re] of [
    ["darwin", /找不到 launchctl/],
    ["win32", /Windows 辅助程序不可用/],
  ] as const) {
    const d2 = join(root, platform);
    mkdirSync(d2, { recursive: true });
    const c2 = await createApp({ dataDir: d2, workspaceHome: root, workspaceRoots: [root], autostartHost: { ...host, platform } });
    try {
      const h = { authorization: `Bearer ${c2.issueToken()}` };
      for (const req of [{ url: "/api/autostart" }, { method: "PUT" as const, url: "/api/autostart", payload: { enabled: true } }]) {
        const r = await c2.app.inject({ ...req, headers: h });
        assert.equal(r.statusCode, 200, r.body);
        const v = r.json();
        assert.equal(v.supported, false);
        assert.equal(v.enabled, false);
        assert.equal(v.manager, null);
        assert.match(v.reason, re);
      }
    } finally {
      await c2.app.close();
    }
  }
  rmSync(root, { recursive: true, force: true });
});
