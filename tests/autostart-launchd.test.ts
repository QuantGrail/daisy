/**
 * P5-04 (ADR-140): start at login on macOS — a per-user LaunchAgent.
 *
 * `launchctl` is a fake (never the real one: the owner's launchd); the
 * plist is real, written under a temporary HOME. The fake behaves like
 * launchd where it matters: `bootstrap` loads the plist and, RunAtLoad,
 * starts the very ProgramArguments / EnvironmentVariables / WorkingDirectory
 * / StandardOutPath it names (so the real Daisy process runs from what was
 * written), `kickstart` starts a loaded job, `bootout` sends SIGTERM and
 * unloads. Runs on Linux too (the platform is the injected one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daisy, testIo } from "./cli-fixture.ts";
import type { ExecResult } from "../packages/daisy/src/cli/io.ts";
import { pidAlive } from "../packages/daisy/src/cli/daisy.ts";
import { SERVER_MAIN } from "../packages/daisy/src/cli/code.ts";
import {
  LAUNCHD_LABEL,
  launchdLabel,
  parseDisabled,
  parsePrint,
  plistString,
  plistText,
} from "../packages/daisy/src/platform/launchd.ts";
import { supervision } from "../packages/daisy/src/update/restart.ts";
import { dataDir as conventional } from "../packages/daisy/src/platform/paths.ts";

const POSIX = { skip: process.platform === "win32" ? "launchd 的测试要 POSIX 进程（Windows 是 P5-05 的）" : false };
const ENV = { DAISY_LOCAL_RUNNER: "0" };
const tmp = () => realpathSync.native(mkdtempSync(join(tmpdir(), "daisy-launchd-")));
const UID = process.getuid?.() ?? 0;
const GUI = `gui/${UID}`;

/** Our own plist's fields (the format plistText writes). */
function readPlist(text: string) {
  const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const after = (key: string) => text.slice(text.indexOf(`<key>${key}</key>`) + key.length + 11);
  const strings = (block: string) => [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]!));
  const one = (key: string) => strings(after(key).split("\n")[1] ?? "")[0]!;
  const args = strings(after("ProgramArguments").slice(0, after("ProgramArguments").indexOf("</array>")));
  const envBlock = after("EnvironmentVariables").slice(0, after("EnvironmentVariables").indexOf("</dict>"));
  const env: Record<string, string> = {};
  for (const m of envBlock.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) env[m[1]!] = unxml(m[2]!);
  return { label: one("Label"), args, env, cwd: one("WorkingDirectory"), out: one("StandardOutPath") };
}

/** A fake launchd for one GUI domain: jobs by label, a record of the calls. */
function fakeLaunchd(o: { gui?: boolean } = {}) {
  const jobs = new Map<string, { plist: string; pid: number | null }>();
  const disabled = new Set<string>();
  const calls: string[] = [];
  const run = (label: string) => {
    const j = jobs.get(label)!;
    const p = readPlist(readFileSync(j.plist, "utf8"));
    const fd = openSync(p.out, "a");
    const child = spawn(p.args[0]!, p.args.slice(1), {
      cwd: p.cwd,
      // launchd gives a job little of the caller's environment: the plist's, and HOME.
      env: { ...process.env, ...ENV, ...p.env },
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    child.unref();
    j.pid = child.pid ?? null;
  };
  const exec = (cmd: string, args: string[]): ExecResult | undefined => {
    if (cmd !== "launchctl") return undefined;
    calls.push(args.join(" "));
    const [verb, target, file] = args;
    if (o.gui === false && verb !== "print-disabled")
      return { code: 113, stdout: "", stderr: `Could not find domain for ${GUI}` };
    const label = target?.startsWith(`${GUI}/`) ? target.slice(GUI.length + 1) : "";
    const j = jobs.get(label);
    switch (verb) {
      case "print":
        if (target === GUI) return { code: 0, stdout: `${GUI} = {\n\ttype = gui\n}\n`, stderr: "" };
        if (!j) return { code: 113, stdout: "", stderr: `Could not find service "${label}" in domain for user gui: ${UID}` };
        return {
          code: 0,
          stdout: j.pid && pidAlive(j.pid) ? `${target} = {\n\tstate = running\n\tpid = ${j.pid}\n\t\tstate = active\n}\n` : `${target} = {\n\tstate = not running\n}\n`,
          stderr: "",
        };
      case "print-disabled":
        return { code: 0, stdout: `\tdisabled services = {\n${[...disabled].map((l) => `\t\t"${l}" => disabled\n`).join("")}\t}\n`, stderr: "" };
      case "enable":
        disabled.delete(label);
        return { code: 0, stdout: "", stderr: "" };
      case "bootstrap": {
        const l = readPlist(readFileSync(file!, "utf8")).label;
        if (jobs.has(l)) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
        jobs.set(l, { plist: file!, pid: null });
        run(l); // RunAtLoad
        return { code: 0, stdout: "", stderr: "" };
      }
      case "kickstart":
        if (!j) return { code: 113, stdout: "", stderr: "Could not find service" };
        if (!(j.pid && pidAlive(j.pid))) run(label);
        return { code: 0, stdout: "", stderr: "" };
      case "bootout":
        if (!j) return { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" };
        if (j.pid && pidAlive(j.pid)) process.kill(j.pid, "SIGTERM");
        jobs.delete(label);
        return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unknown verb ${verb}` };
  };
  return { exec, calls, jobs, disabled };
}

test("plist text: label, the Daisy process itself, RunAtLoad, KeepAlive on failure, logs, umask, XML-escaped", () => {
  const dflt = conventional({ HOME: "/Users/u" }, "darwin", "/Users/u");
  assert.equal(launchdLabel(dflt, true), "ai.daisy.daisy");
  assert.equal(LAUNCHD_LABEL, "ai.daisy.daisy");
  assert.match(launchdLabel("/srv/other", false), /^ai\.daisy\.daisy-[0-9a-f]{8}$/);
  assert.equal(plistString("/a & <b>"), "<string>/a &amp; &lt;b&gt;</string>");
  assert.throws(() => plistString("/a\nb"), /控制字符/);
  const t = plistText({
    label: "ai.daisy.daisy",
    dataDir: dflt,
    explicitDataDir: false,
    node: "/n/node",
    args: ["--import", "file:///t/tsx.mjs", "/c/main.ts"],
    cwd: "/c",
    path: "/n:/usr/bin",
    log: `${dflt}/logs/daisy.log`,
  });
  const p = readPlist(t);
  assert.equal(p.label, "ai.daisy.daisy");
  assert.deepEqual(p.args, ["/n/node", "--import", "file:///t/tsx.mjs", "/c/main.ts"]);
  assert.equal(p.cwd, "/c");
  assert.deepEqual(p.env, { PATH: "/n:/usr/bin", DAISY_LAUNCHD_LABEL: "ai.daisy.daisy" }, "no DAISY_DATA for the default data directory");
  assert.equal(p.out, `${dflt}/logs/daisy.log`);
  assert.match(t, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(t, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(t, /<key>ExitTimeOut<\/key>\s*<integer>45<\/integer>/);
  assert.match(t, /<key>Umask<\/key>\s*<integer>63<\/integer>/, "077");
  assert.match(t, /<key>StandardErrorPath<\/key>\s*<string>[^<]*daisy\.log<\/string>/);
  assert.doesNotMatch(t, /UserName|GroupName|DAISY_PORT|<key>Sockets/, "no user switch, no port (ADR-102)");
  // launchctl's own readings.
  assert.deepEqual(parsePrint("gui/501/x = {\n\tstate = running\n\tpid = 4242\n\t\tstate = active\n}"), { running: true, pid: 4242 });
  assert.deepEqual(parsePrint("gui/501/x = {\n\tstate = not running\n}"), { running: false, pid: null });
  assert.equal(parseDisabled('\t\t"ai.daisy.daisy" => disabled\n', "ai.daisy.daisy"), true);
  assert.equal(parseDisabled('\t\t"ai.daisy.daisy" => enabled\n\t\t"ai.daisy.daisyX" => disabled\n', "ai.daisy.daisy"), false);
  assert.equal(parseDisabled('\t\t"ai.daisy.daisy" => true\n', "ai.daisy.daisy"), true, "older macOS");
});

test("autostart on (macOS): a LaunchAgent in ~/Library/LaunchAgents — no root, nothing started; off deletes it", async () => {
  const root = tmp();
  const dir = join(root, "data");
  const ld = fakeLaunchd();
  const env = { ...ENV, HOME: join(root, "home"), PATH: "/opt/node/bin:/Users/u/.local/bin:relative/bin" };
  try {
    let io = testIo({ env, exec: ld.exec, platform: "darwin" });
    let r = await daisy(io, dir, "autostart", "on");
    assert.equal(r.code, 0, r.err);
    const label = launchdLabel(dir, false);
    const file = join(root, "home", "Library", "LaunchAgents", `${label}.plist`);
    assert.match(r.out, new RegExp(`开机自启已开启：launchd 登录项 ${label.replace(/\./g, "\\.")}（${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}），在你登录后启动`));
    assert.match(r.out, /现在没在运行：daisy start 会经 launchd 启动它/);
    const text = readFileSync(file, "utf8");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o644, "launchd refuses a group/other-writable plist");
    const p = readPlist(text);
    assert.equal(p.label, label);
    assert.equal(p.args[0], process.execPath);
    assert.equal(p.args.at(-1), SERVER_MAIN, "runs the Daisy process itself");
    assert.equal(p.env.DAISY_DATA, dir, "an explicit data directory is written");
    assert.equal(p.env.DAISY_LAUNCHD_LABEL, label);
    assert.match(p.env.PATH!, /\/Users\/u\/\.local\/bin/);
    assert.doesNotMatch(p.env.PATH!, /relative\/bin/, "only absolute PATH entries");
    assert.equal(p.out, join(dir, "logs", "daisy.log"));
    // The log launchd appends to is private before launchd ever opens it.
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "logs")).mode & 0o777, 0o700);
    if (process.platform !== "win32") assert.equal(statSync(p.out).mode & 0o777, 0o600);
    if (process.platform === "darwin") execFileSync("plutil", ["-lint", file]);
    assert.ok(ld.calls.includes(`enable ${GUI}/${label}`), ld.calls.join("\n"));
    assert.ok(ld.calls.every((c) => /^(print|print-disabled|enable) /.test(c)), ld.calls.join("\n"));
    assert.ok(!ld.calls.some((c) => /^(bootstrap|kickstart)/.test(c)), "on does not start it");
    assert.ok(io.execs.every((e) => e.cmd !== "sudo" && e.cmd !== "systemctl"), "never root, never systemd");

    // A disabled override (launchctl disable) is lifted by the next `on`.
    ld.disabled.add(label);
    io = testIo({ env, exec: ld.exec, platform: "darwin" });
    r = await daisy(io, dir, "autostart");
    assert.match(r.out, /开机自启：plist 在但被停用了（launchd 登录项/);
    io = testIo({ env, exec: ld.exec, platform: "darwin" });
    r = await daisy(io, dir, "autostart", "on");
    assert.equal(r.code, 0, r.err);
    assert.equal(ld.disabled.has(label), false);
    io = testIo({ env, exec: ld.exec, platform: "darwin" });
    r = await daisy(io, dir, "autostart");
    assert.match(r.out, /开机自启：已开启（launchd 登录项 .*在你登录后启动）/);
    assert.match(r.out, /plist\s+.*\.plist/);
    assert.match(r.out, /钥匙串/);

    io = testIo({ env, exec: ld.exec, platform: "darwin" });
    r = await daisy(io, dir, "doctor", "--json");
    const check = JSON.parse(r.out).find((c: any) => c.name === "开机自启");
    assert.equal(check.level, "ok");
    assert.match(check.detail, /launchd 登录项 .* 已启用/);

    io = testIo({ env, exec: ld.exec, platform: "darwin" });
    r = await daisy(io, dir, "autostart", "off");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /开机自启已关闭/);
    assert.equal(existsSync(file), false, "the plist is deleted");
    io = testIo({ env, exec: ld.exec, platform: "darwin" });
    r = await daisy(io, dir, "autostart", "off");
    assert.match(r.out, /本来就没开/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS with autostart on: start loads the LaunchAgent (its plist starts Daisy), status says launchd, stop boots it out; uninstall leaves nothing", POSIX, async () => {
  const root = tmp();
  const dir = join(root, "data");
  const ld = fakeLaunchd();
  const env = { ...ENV, HOME: join(root, "home") };
  const label = launchdLabel(dir, false);
  const file = join(root, "home", "Library", "LaunchAgents", `${label}.plist`);
  const io = () => testIo({ env, exec: ld.exec, platform: "darwin" });
  try {
    let r = await daisy(io(), dir, "autostart", "on");
    assert.equal(r.code, 0, r.err);
    r = await daisy(io(), dir, "start", "--port", "29999");
    assert.equal(r.code, 2, "the port is the plist's");
    assert.match(r.err, /launchd 的 plist/);

    r = await daisy(io(), dir, "start");
    assert.equal(r.code, 0, r.err + r.out);
    assert.ok(ld.calls.includes(`bootstrap ${GUI} ${file}`), ld.calls.join("\n"));
    assert.match(r.out, /托管方式\s+launchd（在你的登录会话里）/);
    assert.doesNotMatch(r.out, /建议：macOS/, "no advice when it already went through launchd");
    const pid: number = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")).pid;
    assert.equal(pid, ld.jobs.get(label)!.pid, "the process launchd started from the plist");
    assert.ok(readFileSync(join(dir, "logs", "daisy.log"), "utf8").length > 0, "its output goes to the plist's log");

    r = await daisy(io(), dir, "status");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`托管方式\\s+launchd（${label.replace(/\./g, "\\.")}；日志 `));
    assert.match(r.out, /开机自启\s+已开启（launchd 登录项/);
    r = await daisy(io(), dir, "status", "--json");
    const j = JSON.parse(r.out);
    assert.equal(j.managedBy, "launchd");
    assert.equal(j.autostart.manager, "launchd");
    assert.equal(j.autostart.active, true);

    r = await daisy(io(), dir, "stop");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /已停止（进程号 \d+，经 launchd）/);
    assert.ok(ld.calls.includes(`bootout ${GUI}/${label}`));
    assert.equal(pidAlive(pid), false);
    assert.equal(ld.jobs.has(label), false, "unloaded: launchd does not start it again");

    // Loaded but not running (it exited 0 after a stop from elsewhere): kickstart.
    r = await daisy(io(), dir, "start");
    assert.equal(r.code, 0, r.err);
    let pid2 = ld.jobs.get(label)!.pid!;
    process.kill(pid2, "SIGTERM");
    for (let i = 0; i < 200 && pidAlive(pid2); i++) await new Promise((x) => setTimeout(x, 50));
    ld.calls.length = 0;
    r = await daisy(io(), dir, "start");
    assert.equal(r.code, 0, r.err);
    assert.ok(ld.calls.includes(`kickstart ${GUI}/${label}`), ld.calls.join("\n"));
    pid2 = ld.jobs.get(label)!.pid!;
    assert.ok(pidAlive(pid2));

    // I-3: uninstall stops it through launchd, deletes the plist, leaves nothing loaded.
    r = await daisy(io(), dir, "uninstall", "--yes");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /✓ 已停止 Daisy/);
    assert.match(r.out, /✓ 已停用并删除开机自启的单元/);
    assert.equal(pidAlive(pid2), false);
    assert.equal(existsSync(file), false);
    assert.equal(ld.jobs.size, 0);
    assert.ok(existsSync(join(dir, "keys", "cli-credential")), "the data directory stays");
  } finally {
    for (const j of ld.jobs.values()) if (j.pid && pidAlive(j.pid)) process.kill(j.pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS: no GUI login (ssh only) — start through launchd says how; autostart off then starts a background process with the keychain advice", POSIX, async () => {
  const root = tmp();
  const dir = join(root, "data");
  const ld = fakeLaunchd({ gui: false });
  const env = { ...ENV, HOME: join(root, "home") };
  const io = () => testIo({ env, exec: ld.exec, platform: "darwin" });
  try {
    // The plist is written all the same: launchd loads it at the next login.
    let r = await daisy(io(), dir, "autostart", "on");
    assert.equal(r.code, 1, "launchctl enable needs the GUI domain");
    assert.match(r.err, /启用开机自启失败[\s\S]*怎么办：/);
    r = await daisy(io(), dir, "start");
    assert.equal(r.code, 1);
    assert.match(r.err, /launchd 没能启动[\s\S]*要有人登录这台 Mac 的桌面/);
    r = await daisy(io(), dir, "autostart", "off");
    assert.equal(r.code, 0, r.err);
    r = await daisy(io(), dir, "start");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /建议：macOS 上用 daisy autostart on 交给 launchd[\s\S]*钥匙串/);
    r = await daisy(io(), dir, "stop");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /已停止（进程号 \d+）/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervision under launchd: the plist's label and launchd as the parent — both needed", () => {
  const ld = supervision({ env: { DAISY_LAUNCHD_LABEL: "ai.daisy.daisy" }, ppid: 1, platform: "darwin", parentName: () => "launchd" });
  assert.deepEqual(ld, { supervised: true, manager: "launchd", unit: "ai.daisy.daisy", platform: "darwin" });
  assert.equal(supervision({ env: { DAISY_LAUNCHD_LABEL: "ai.daisy.daisy-0123abcd" }, ppid: 1, platform: "darwin" }).unit, "ai.daisy.daisy-0123abcd");
  // Reparented to launchd without the label: a background process (daisy start drops the variable).
  assert.equal(supervision({ env: {}, ppid: 1, platform: "darwin", parentName: () => "launchd" }).supervised, false);
  // The label inherited by something started from a terminal: not launchd's child.
  assert.equal(supervision({ env: { DAISY_LAUNCHD_LABEL: "ai.daisy.daisy" }, ppid: 4242, platform: "darwin", parentName: () => "zsh" }).supervised, false);
  // A label that is not ours; Linux; self-restart switched off.
  assert.equal(supervision({ env: { DAISY_LAUNCHD_LABEL: "com.apple.Terminal" }, ppid: 1, platform: "darwin" }).supervised, false);
  assert.equal(supervision({ env: { DAISY_LAUNCHD_LABEL: "ai.daisy.daisy" }, ppid: 1, platform: "linux", parentName: () => "init" }).supervised, false);
  assert.equal(
    supervision({ env: { DAISY_LAUNCHD_LABEL: "ai.daisy.daisy", DAISY_RUNNER_SELF_RESTART: "0" }, ppid: 1, platform: "darwin" }).supervised,
    false,
  );
});

test("settings.autostartStatus / autostartSet on macOS: the LaunchAgent `daisy autostart` writes", async () => {
  const { createApp } = await import("../packages/daisy/src/app.ts");
  const root = tmp();
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  const ld = fakeLaunchd();
  const env = { ...process.env, HOME: join(root, "home"), DAISY_DATA: dir };
  const host = {
    env,
    platform: "darwin" as NodeJS.Platform,
    exec: async (cmd: string, args: readonly string[]) => ld.exec(cmd, [...args]) ?? { code: 127, stdout: "", stderr: "", missing: true },
  };
  const ctx = await createApp({ dataDir: dir, workspaceHome: root, workspaceRoots: [root], autostartHost: host });
  try {
    const h = { authorization: `Bearer ${ctx.issueToken()}` };
    const label = launchdLabel(dir, false);
    let r = await ctx.app.inject({ url: "/api/autostart", headers: h });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { supported: true, enabled: false, manager: "launchd", unit: label });
    r = await ctx.app.inject({ method: "PUT", url: "/api/autostart", headers: h, payload: { enabled: true } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().enabled, true);
    assert.match(r.json().hint, /登录后由 launchd 启动[\s\S]*钥匙串/);
    assert.ok(existsSync(join(root, "home", "Library", "LaunchAgents", `${label}.plist`)));
    const io = testIo({ env, exec: ld.exec, platform: "darwin" });
    const c = await daisy(io, dir, "autostart");
    assert.match(c.out, /开机自启：已开启（launchd/);
    r = await ctx.app.inject({ method: "PUT", url: "/api/autostart", headers: h, payload: { enabled: false } });
    assert.equal(r.json().enabled, false);
    assert.equal(existsSync(join(root, "home", "Library", "LaunchAgents", `${label}.plist`)), false);
  } finally {
    await ctx.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
