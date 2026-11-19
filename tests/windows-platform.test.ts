// P5-05 (ADR-141): Windows. The pure parts run everywhere — command-line
// quoting, finding a CLI on PATH × PATHEXT without a shell (npm shims, Node
// scripts), the shell for typed commands, owner-only ACLs read from SDDL,
// the process table and tree, the helper's job / pty / supervise arguments,
// the HKCU Run entry (through a fake helper), the stop request, the
// capability overlay. The parts that need Windows itself — the compiled
// helper, Job Objects ending a whole tree (C-4) also when Daisy dies,
// ConPTY, ACLs — run only there (Windows CI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  commandLine,
  encodePowerShell,
  findOnPath,
  parseShim,
  quoteArg,
  resolveCommand,
  splitCommandLine,
  windowsShell,
  CommandRefused,
  type Fs,
} from "../packages/daisy/src/platform/windows/cmdline.ts";
import { ownerOnlyAcl, parseAcl } from "../packages/daisy/src/platform/windows/acl.ts";
import { parseWinPs } from "../packages/daisy/src/platform/proc-table.ts";
import { processTree } from "../packages/daisy/src/platform/process-groups.ts";
import { helperArgs } from "../packages/daisy/src/platform/spawn.ts";
import {
  parseRunGet,
  runEntry,
  runValueName,
  superviseArgs,
  WIN_SUPERVISOR_RE,
} from "../packages/daisy/src/platform/windows/autostart.ts";
import { cscArgs, cscCandidates, envGet, helperRoot } from "../packages/daisy/src/platform/windows/helper.ts";
import { requestStop, stopRequestFile, watchStopRequest } from "../packages/daisy/src/platform/windows/stop.ts";
import { applyPlatform, platformReport } from "../packages/daisy/src/platform/capabilities.ts";
import { absRule } from "../packages/daisy/src/turns/sidecar.ts";
import { stripTrailing, within } from "../packages/daisy/src/app/workspaces.ts";
import { otherWindowsProfiles } from "../packages/daisy/src/access/shared-host.ts";
import { windowsAccountNumber, systemUid } from "../packages/daisy/src/access/ports.ts";
import { supervision } from "../packages/daisy/src/update/restart.ts";
import { capabilitiesFor } from "../packages/contracts/src/agent-capabilities.ts";
import { featureMap } from "../packages/contracts/src/agent-features.ts";
import { autostartOff, autostartOn, autostartState, autostartView, processHost } from "../packages/daisy/src/platform/autostart.ts";
import { PRODUCT_NAME } from "../packages/contracts/src/names.ts";

const WIN = process.platform === "win32";
const ONLY_WIN = { skip: WIN ? false : "needs Windows (Windows CI)" };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── command lines ────────────────────────────────────────────────────────

test("quoteArg / commandLine: every argument comes back whole (MSVCRT / CommandLineToArgvW rules)", () => {
  const cases = [
    "plain",
    "",
    "with space",
    'say "hi"',
    "C:\\Program Files\\x\\",
    "trailing\\\\",
    'back\\"quote',
    "a&b|c^d%PATH%<>",
    "tab\there",
    "多字节 路径",
    "\\\\server\\share",
  ];
  for (const a of cases) assert.deepEqual(splitCommandLine(quoteArg(a)), [a], JSON.stringify(a));
  assert.deepEqual(splitCommandLine(commandLine(cases)), cases);
  assert.equal(quoteArg("plain"), "plain");
  assert.equal(quoteArg(""), '""');
  assert.equal(quoteArg("C:\\a b\\"), '"C:\\a b\\\\"', "a trailing backslash is doubled before the closing quote");
  assert.throws(() => quoteArg("a\0b"));
});

const fakeFs = (files: Record<string, string>): Fs => {
  const norm = (p: string) => p.toLowerCase();
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return { isFile: (p) => map.has(norm(p)), read: (p) => map.get(norm(p)) ?? "" };
};

const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;
const OLD_SHIM = `@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*
)`;

test("resolveCommand: PATH × PATHEXT, never the current folder; .exe as is; npm shims run their script under node; other batch files refused", () => {
  const env = { Path: "C:\\Users\\a\\.local\\bin;C:\\Users\\a\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const fs = fakeFs({
    "C:\\Users\\a\\.local\\bin\\claude.exe": "",
    "C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd": NPM_SHIM,
    "C:\\Users\\a\\AppData\\Roaming\\npm\\npm.cmd": OLD_SHIM,
    "C:\\Users\\a\\AppData\\Roaming\\npm\\evil.cmd": "@echo off\r\ncalc.exe %*",
    "C:\\Program Files\\nodejs\\node.exe": "",
  });
  // Found on PATH (Path spelled the Windows way), the .exe as it is.
  assert.deepEqual(resolveCommand("claude", ["-p", "a&b"], env, fs, "X:\\node.exe"), {
    file: "C:\\Users\\a\\.local\\bin\\claude.exe",
    args: ["-p", "a&b"],
  });
  // An npm shim: node on PATH runs the script — no cmd.exe, so `&` stays an argument.
  assert.deepEqual(resolveCommand("codex", ["app-server", "x&calc"], env, fs, "X:\\node.exe"), {
    file: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "app-server", "x&calc"],
  });
  // node.exe beside the shim wins; the older shim format too.
  const fs2 = fakeFs({
    "C:\\tools\\npm.cmd": OLD_SHIM,
    "C:\\tools\\node.exe": "",
  });
  assert.deepEqual(resolveCommand("npm", ["-v"], { PATH: "C:\\tools" }, fs2), {
    file: "C:\\tools\\node.exe",
    args: ["C:\\tools\\node_modules\\npm\\bin\\npm-cli.js", "-v"],
  });
  // No node anywhere: this Node.
  assert.equal(resolveCommand("codex", [], { PATH: "C:\\Users\\a\\AppData\\Roaming\\npm" }, fs, "X:\\node.exe")!.file, "X:\\node.exe");
  // A batch file that is not a shim: refused, never run through cmd.exe.
  assert.throws(() => resolveCommand("evil", [], env, fs), CommandRefused);
  // Not installed: null (the caller's spawn says ENOENT as always).
  assert.equal(resolveCommand("kimi", [], env, fs), null);
  // Never the current folder, never a relative PATH entry.
  assert.equal(findOnPath("claude", { PATH: ".;relative\\bin" }, fakeFs({ ".\\claude.exe": "", "relative\\bin\\claude.exe": "" })), null);
  // An explicit path without extension finds the .exe beside it.
  assert.equal(findOnPath("C:\\Users\\a\\.local\\bin\\claude", env, fs), "C:\\Users\\a\\.local\\bin\\claude.exe");
});

test("resolveCommand: a Node script named by path (DAISY_*_BIN = …\\agent.cjs, a #!…node file) runs under node; a shell script is refused", () => {
  const fs = fakeFs({
    "D:\\a\\tests\\fixtures\\agent.cjs": "#!/usr/bin/env node\n",
    "D:\\a\\bin\\tool": "#!/usr/bin/env node\nconsole.log(1)",
    "D:\\a\\bin\\fake-claude": "#!/bin/sh\necho hi",
  });
  assert.deepEqual(resolveCommand("D:\\a\\tests\\fixtures\\agent.cjs", ["--version"], {}, fs, "N:\\node.exe"), {
    file: "N:\\node.exe",
    args: ["D:\\a\\tests\\fixtures\\agent.cjs", "--version"],
  });
  assert.deepEqual(resolveCommand("D:\\a\\bin\\tool", [], {}, fs, "N:\\node.exe")!.args, ["D:\\a\\bin\\tool"]);
  assert.throws(() => resolveCommand("D:\\a\\bin\\fake-claude", [], {}, fs), CommandRefused);
});

test("parseShim: cmd-shim (npm 7+), the older npm shim, and not a shim", () => {
  assert.deepEqual(parseShim(NPM_SHIM), { script: "node_modules\\@openai\\codex\\bin\\codex.js", prog: "node" });
  assert.deepEqual(parseShim(OLD_SHIM), { script: "node_modules\\npm\\bin\\npm-cli.js", prog: "node" });
  assert.equal(parseShim("@echo off\r\ncalc.exe %*"), null);
});

test("windowsShell: Git Bash (Program Files, or beside git on PATH), never WSL's bash.exe; else PowerShell with -EncodedCommand", () => {
  const env = { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32" };
  const has = (files: string[]) => (p: string) => files.map((f) => f.toLowerCase()).includes(p.toLowerCase());
  let sh = windowsShell(env, has(["C:\\Program Files\\Git\\bin\\bash.exe"]));
  assert.equal(sh.kind, "git-bash");
  assert.deepEqual(sh.args("echo hi", true), ["-lc", "echo hi"]);
  assert.deepEqual(sh.args("echo hi"), ["-c", "echo hi"]);
  assert.equal(sh.env.CHERE_INVOKING, "1", "a login shell stays in the working folder");
  sh = windowsShell({ ...env, PATH: "D:\\Git\\cmd" }, has(["D:\\Git\\cmd\\git.exe", "D:\\Git\\bin\\bash.exe"]));
  assert.equal(sh.file, "D:\\Git\\bin\\bash.exe");
  // WSL's launcher in System32 is not Git Bash.
  sh = windowsShell({ ...env, PATH: "C:\\Windows\\System32" }, has(["C:\\Windows\\System32\\bash.exe", "C:\\Windows\\System32\\git.exe"]));
  assert.equal(sh.kind, "powershell");
  assert.equal(sh.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const args = sh.args(`echo "a & b" | Out-Host`);
  assert.equal(args.at(-2), "-EncodedCommand");
  assert.equal(Buffer.from(args.at(-1)!, "base64").toString("utf16le"), `echo "a & b" | Out-Host`);
  assert.equal(encodePowerShell("x"), Buffer.from("x", "utf16le").toString("base64"));
});

// ── owner-only (ACL) ─────────────────────────────────────────────────────

const ME = "S-1-5-21-1111111111-2222222222-3333333333-1001";
/** The helper's acl-get output: this user, owner, protected, then the entries. */
const aclText = (owner: string, entries: string[], user = ME, prot = 1) =>
  [user, `O ${owner}`, `P ${prot}`, ...entries].join("\r\n") + "\r\n";
const FULL = 2032127; // FileSystemRights.FullControl
test("ownerOnlyAcl: only this account, SYSTEM and Administrators may be let in (what acl-set writes passes); every SID in full", () => {
  const written = aclText(ME, [`A 0 3 0 ${FULL} ${ME}`, `A 0 3 0 ${FULL} S-1-5-18`, `A 0 3 0 ${FULL} S-1-5-32-544`]);
  assert.equal(ownerOnlyAcl(parseAcl(written)), true);
  // The account with RID 500 (SDDL would write it LA): judged by its full SID.
  const admin = "S-1-5-21-9-9-9-500";
  assert.equal(ownerOnlyAcl(parseAcl(aclText(admin, [`A 1 0 0 ${FULL} ${admin}`], admin))), true);
  assert.equal(ownerOnlyAcl(parseAcl(aclText("S-1-5-32-544", [`A 0 0 0 ${FULL} ${ME}`]))), true, "owned by Administrators (an elevated owner)");
  assert.equal(ownerOnlyAcl(parseAcl(aclText(ME, [`A 1 0 0 ${FULL} ${ME}`, `A 1 0 0 1179817 S-1-5-32-545`], ME, 0))), false, "Users can read");
  assert.equal(ownerOnlyAcl(parseAcl(aclText(ME, [`A 1 3 0 1245631 S-1-5-11`]))), false, "Authenticated Users");
  assert.equal(ownerOnlyAcl(parseAcl(aclText(ME, [`A 0 0 0 ${FULL} S-1-1-0`]))), false, "Everyone");
  assert.equal(ownerOnlyAcl(parseAcl(aclText(ME, [`A 0 0 0 ${FULL} S-1-5-21-1111111111-2222222222-3333333333-1002`]))), false, "another account");
  assert.equal(ownerOnlyAcl(parseAcl(aclText("S-1-5-21-9-9-9-1002", [`A 0 0 0 ${FULL} ${ME}`]))), false, "owned by someone else");
  assert.equal(ownerOnlyAcl(parseAcl(aclText("-", [`A 0 0 0 ${FULL} ${ME}`]))), false, "no owner readable");
  assert.equal(ownerOnlyAcl(parseAcl(aclText(ME, [`D 0 0 0 ${FULL} S-1-1-0`, `A 0 0 0 ${FULL} ${ME}`]))), true, "a deny lets no one in");
  assert.equal(ownerOnlyAcl(parseAcl(aclText(ME, [`A 0 0 0 ${FULL} ${ME}`, `A 0 3 2 ${FULL} S-1-3-0`]))), true, "CREATOR OWNER, inherit-only");
  assert.equal(ownerOnlyAcl(parseAcl(aclText(ME, [`A 0 0 0 ${FULL} ${ME}`, `A 0 3 0 ${FULL} S-1-3-0`]))), false, "CREATOR OWNER applying here is not");
  assert.equal(ownerOnlyAcl(parseAcl(aclText(ME, [`A 0 0 0 ${FULL} ${ME.toLowerCase()}`]))), true, "SIDs compare without case");
  assert.equal(ownerOnlyAcl(parseAcl("")), false, "nothing read: not owner-only");
  assert.deepEqual(parseAcl(aclText("S-1-5-18", [`A 1 3 0 ${FULL} S-1-5-18`])).entries, [
    { allow: true, inherited: true, inheritance: 3, propagation: 0, rights: FULL, sid: "S-1-5-18" },
  ]);
});

// ── the process table and tree ───────────────────────────────────────────

test("parseWinPs + processTree (Windows rules): descendants by parent, a child only if it started no earlier than its parent (a reused parent id), never this process or its ancestors", () => {
  const t = parseWinPs(
    [
      "0\t0\t0\t[System Process]",
      `${process.pid}\t${process.ppid}\t100\tnode.exe`,
      `${process.ppid}\t1\t50\tdaisy-win.exe`,
      "500\t" + process.pid + "\t200\tdaisy-win.exe", // the job helper
      "501\t500\t210\tnode.exe", // the harness
      "502\t503\t230\tgit.exe", // its grandchild, whose parent 503 exited
      "504\t501\t240\tcmd.exe",
      "505\t504\t90\tunrelated.exe", // names 504 as parent but is older: a reused id
      "506\t501\t250\tsearch indexer.exe",
      "garbage line",
    ].join("\r\n"),
  );
  assert.equal(t.size, 8);
  assert.deepEqual(t.get(501), { pid: 501, ppid: 500, pgid: 0, start: "210", comm: "node.exe", zombie: false });
  assert.equal(t.get(506)!.comm, "search indexer.exe");
  const tree = processTree(500, t, "win32").map((x) => x.pid).sort();
  assert.deepEqual(tree, [500, 501, 504, 506], "502's parent is gone (the job ends it); 505 is not a descendant");
  // Big FILETIMEs compare exactly (beyond 2^53).
  const big = parseWinPs(["10\t1\t133500000000000001\ta", "11\t10\t133500000000000000\tb"].join("\n"));
  assert.deepEqual(processTree(10, big, "win32").map((x) => x.pid), [10], "a child cannot start before its parent");
  const fromParent = processTree(process.ppid, t, "win32").map((x) => x.pid);
  assert.ok(!fromParent.includes(process.pid) && !fromParent.includes(process.ppid), "this process and its ancestors are never in a tree it stops");
});

// ── the helper's arguments ───────────────────────────────────────────────

test("helperArgs: the job / pty helper gets Daisy's pid, the program and one command line that splits back exactly", () => {
  const a = helperArgs("job", "C:\\Program Files\\nodejs\\node.exe", ["C:\\x y\\cli.js", 'say "hi" & bye'], { parent: 42 });
  assert.deepEqual(a.slice(0, 5), ["job", "--parent", "42", "--app", "C:\\Program Files\\nodejs\\node.exe"]);
  assert.equal(a[5], "--cmdline");
  assert.deepEqual(splitCommandLine(a[6]!), ["C:\\Program Files\\nodejs\\node.exe", "C:\\x y\\cli.js", 'say "hi" & bye']);
  const p = helperArgs("pty", "C:\\c.exe", [], { parent: 1, cols: 120, rows: 40, breakaway: true });
  assert.deepEqual(p.slice(0, 8), ["pty", "--parent", "1", "--cols", "120", "--rows", "40", "--breakaway-ok"]);
});

test("helper: compiled by the csc.exe Windows ships, as a GUI program, into a per-user folder", () => {
  assert.deepEqual(cscCandidates({ SystemRoot: "C:\\Windows" }), [
    "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
    "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
  ]);
  assert.ok(cscArgs("s.cs", "o.exe").includes("/target:winexe"), "no console window of its own");
  assert.equal(helperRoot({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }), "C:\\Users\\a\\AppData\\Local\\Programs\\Daisy\\helper");
  assert.equal(envGet({ Path: "x" }, "PATH"), "x");
});

// ── start at login (HKCU Run) ────────────────────────────────────────────

const input = {
  helper: "C:\\Users\\a\\AppData\\Local\\Programs\\Daisy\\helper\\abc\\daisy-win.exe",
  name: PRODUCT_NAME,
  log: "C:\\Users\\a\\AppData\\Local\\Daisy\\logs\\daisy.log",
  cwd: "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@daisy-ai\\daisy",
  node: "C:\\Program Files\\nodejs\\node.exe",
  args: ["--import", "file:///C:/x/quiet.mjs", "C:\\x\\main.ts"],
  dataDir: "D:\\daisy data",
  explicitDataDir: false,
};
test("runEntry / superviseArgs: one command line, no shell; the data directory only when chosen; --once for a plain start", () => {
  const argv = splitCommandLine(runEntry(input));
  assert.equal(argv[0], input.helper);
  assert.equal(argv[1], "supervise");
  const opt = (k: string) => argv[argv.indexOf(k) + 1];
  assert.equal(opt("--name"), PRODUCT_NAME);
  assert.equal(opt("--log"), input.log);
  assert.equal(opt("--cwd"), input.cwd);
  assert.equal(opt("--app"), input.node);
  assert.deepEqual(splitCommandLine(opt("--cmdline")!), [input.node, ...input.args]);
  assert.ok(!argv.includes("--set") && !argv.includes("--once"));
  const explicit = superviseArgs({ ...input, explicitDataDir: true, once: true });
  assert.equal(explicit[explicit.indexOf("--set") + 1], "DAISY_DATA=D:\\daisy data");
  assert.ok(explicit.includes("--once"));
  assert.equal(runValueName("x", true), PRODUCT_NAME);
  assert.match(runValueName("D:\\other", false), WIN_SUPERVISOR_RE);
  assert.notEqual(runValueName("D:\\other", false), runValueName("D:\\another", false));
  assert.equal(parseRunGet("x y\r\n"), "x y");
  assert.equal(parseRunGet(""), null);
  assert.throws(() => runEntry({ ...input, cwd: "C:\\a\nb" }));
});

/** A fake helper behind the "daisy-win" command: an in-memory Run key. */
function fakeRunKey() {
  const values = new Map<string, string>();
  const calls: string[][] = [];
  const exec = async (cmd: string, args: readonly string[]) => {
    calls.push([cmd, ...args]);
    if (cmd !== "daisy-win") return { code: 127, stdout: "", stderr: "", missing: true };
    const [c, name, value] = args;
    if (c === "path") return { code: 0, stdout: input.helper + "\r\n", stderr: "" };
    if (c === "run-get") return { code: 0, stdout: values.has(name!) ? values.get(name!)! + "\r\n" : "", stderr: "" };
    if (c === "run-set") return values.set(name!, value!), { code: 0, stdout: "", stderr: "" };
    if (c === "run-delete") return { code: 0, stdout: values.delete(name!) ? "deleted\n" : "absent\n", stderr: "" };
    return { code: 64, stdout: "", stderr: "unknown" };
  };
  return { values, calls, exec };
}

test("autostart on Windows: on writes the Run value (the helper's supervise), off deletes it; state and the settings view say so; no administrator, nothing started", async () => {
  const k = fakeRunKey();
  const dir = mkdtempSync(join(tmpdir(), "daisy-winrun-"));
  try {
    const ctx = { io: { env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, platform: "win32" as const, exec: k.exec }, dataDir: dir };
    let st = await autostartState(ctx);
    assert.equal(st.manager, "windows-run");
    assert.equal(st.installed, false);
    st = await autostartOn(ctx);
    assert.equal(st.installed, true);
    const name = st.unit;
    assert.match(name, WIN_SUPERVISOR_RE);
    const argv = splitCommandLine(k.values.get(name)!);
    assert.equal(argv[0], input.helper);
    assert.equal(argv[1], "supervise");
    assert.equal(argv[argv.indexOf("--set") + 1], `DAISY_DATA=${dir}`, "an explicit data directory is written");
    assert.ok(!k.calls.some((c) => /start|launchctl|systemctl|schtasks|reg/.test(c[1] ?? "") && c[0] !== "daisy-win"));
    // Idempotent: the same value is not written twice.
    const sets = k.calls.filter((c) => c[1] === "run-set").length;
    await autostartOn(ctx);
    assert.equal(k.calls.filter((c) => c[1] === "run-set").length, sets);
    const view = await autostartView(ctx);
    assert.equal(view.supported, true);
    assert.equal(view.enabled, true);
    assert.equal(view.manager, "windows-run");
    assert.match(view.hint!, /登录 Windows 后启动/);
    assert.equal(await autostartOff(ctx), true);
    assert.equal(k.values.size, 0);
    assert.equal(await autostartOff(ctx), false, "already off");
    assert.equal((await autostartView(ctx)).enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autostart: under node --test the real helper's Run key commands are never run (blocked like launchctl / systemctl)", async () => {
  const r = await processHost().exec("daisy-win", ["run-set", "x", "y"]);
  assert.equal(r.missing, true);
});

test("supervision (Windows): the Run entry's supervisor (DAISY_WIN_SUPERVISOR + parent daisy-win) restarts on exit 75; --once does not", () => {
  const env = { DAISY_WIN_SUPERVISOR: PRODUCT_NAME };
  let s = supervision({ env, platform: "win32", parentName: () => "daisy-win" });
  assert.equal(s.supervised, true);
  assert.equal(s.manager, "supervise");
  assert.equal(s.unit, PRODUCT_NAME);
  s = supervision({ env: { ...env, DAISY_RUNNER_SELF_RESTART: "0" }, platform: "win32", parentName: () => "daisy-win" });
  assert.equal(s.supervised, false, "daisy start without start at login (--once)");
  s = supervision({ env, platform: "win32", parentName: () => "explorer" });
  assert.equal(s.supervised, false, "the variable alone is not enough");
  s = supervision({ env: { DAISY_WIN_SUPERVISOR: "evil;x" }, platform: "win32", parentName: () => "daisy-win" });
  assert.equal(s.supervised, false);
});

test("stop request (Windows `daisy stop`): the Daisy with that pid stops; another pid's or a leftover request is dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-stopreq-"));
  try {
    requestStop(dir, 999999);
    let stopped = 0;
    const end = watchStopRequest(dir, () => stopped++, 4242, 20);
    assert.equal(existsSync(stopRequestFile(dir)), false, "a leftover request is removed at start");
    requestStop(dir, 1);
    await delay(100);
    assert.equal(stopped, 0, "another pid's request");
    assert.equal(existsSync(stopRequestFile(dir)), false);
    requestStop(dir, 4242);
    await delay(100);
    assert.equal(stopped, 1);
    end();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── capabilities (5.14, C-3) ─────────────────────────────────────────────

test("applyPlatform: on Windows Codex's read-only is weak and, without the helper, no CLI window is offered; other systems unchanged", () => {
  const feats = { claude: capabilitiesFor("claude", undefined), codex: capabilitiesFor("codex", undefined) };
  assert.equal(applyPlatform(feats, { platform: "linux", helper: false }), feats);
  const w = applyPlatform(feats, { platform: "win32", helper: true });
  assert.equal(w.codex.readOnly.opts.strength, "weak");
  assert.equal(w.claude.readOnly.opts.strength, "strong", "Claude's read-only is a tool restriction, not a sandbox");
  assert.equal(featureMap(w.codex).terminal, "native");
  const n = applyPlatform(feats, { platform: "win32", helper: false });
  assert.equal(featureMap(n.claude).terminal, "none");
  assert.equal(featureMap(n.codex).terminal, "none");
  assert.equal(feats.codex.readOnly!.opts!.strength, "strong", "a copy");
  assert.deepEqual(applyPlatform(w, { platform: "win32", helper: true }), w, "applying twice changes nothing");
  assert.deepEqual(platformReport({ platform: "win32", helper: true, shell: "git-bash" }), {
    version: 1,
    os: "win32",
    processTree: "job-object",
    terminal: "conpty",
    enforcedReadOnly: false,
    shell: "git-bash",
    ownerOnly: "acl",
  });
  assert.equal(platformReport({ platform: "win32", helper: false }).processTree, "parent-only");
  assert.equal(platformReport({ platform: "darwin", helper: false }).enforcedReadOnly, false);
  assert.equal(platformReport({ platform: "linux", helper: false }, true).enforcedReadOnly, true);
});

// ── paths, accounts ──────────────────────────────────────────────────────

test("Windows paths: Claude Code rule paths (//c/…), workspace roots (case-insensitive), drive roots", () => {
  assert.equal(absRule("C:\\Users\\a\\.claude", "win32"), "//c/Users/a/.claude");
  assert.equal(absRule("D:\\", "win32"), "//d");
  assert.equal(absRule("/home/a/.claude", "linux"), "//home/a/.claude");
  assert.equal(absRule("C:\\x\\y", "win32"), "//c/x/y");
  assert.equal(within(win32, "C:\\Users\\A", "c:\\users\\a\\proj"), true);
  assert.equal(within(win32, "C:\\Users\\A", "C:\\Users\\AB"), false);
  assert.equal(within(win32, "C:\\Users\\A", "D:\\Users\\A"), false);
  assert.equal(within(win32, "C:\\", "C:\\x"), true);
  assert.equal(within(posix, "/", "/x"), true);
  assert.equal(within(posix, "/home/a", "/home/ab"), false);
  assert.equal(stripTrailing(win32, "C:\\"), "C:\\");
  assert.equal(stripTrailing(win32, "C:\\x\\"), "C:\\x");
  assert.equal(stripTrailing(posix, "/"), "/");
});

test("Windows accounts: other people's profiles make it a shared machine; each account derives its own port number", () => {
  const list = [
    "S-1-5-18",
    "S-1-5-19",
    "S-1-5-20",
    ME,
    "S-1-5-21-1111111111-2222222222-3333333333-500",
  ].join("\r\n");
  assert.deepEqual(otherWindowsProfiles(list, ME), [], "system accounts and the built-in Administrator (RID 500) are not people");
  assert.deepEqual(otherWindowsProfiles(list + "\r\nS-1-5-21-1-2-3-1002", ME), ["S-1-5-21-1-2-3-1002"]);
  assert.deepEqual(otherWindowsProfiles("S-1-12-1-11-22-33-44", ME), ["S-1-12-1-11-22-33-44"], "a Microsoft Entra account");
  assert.equal(windowsAccountNumber("PC\\Alice"), windowsAccountNumber("pc\\alice"));
  assert.notEqual(windowsAccountNumber("PC\\alice"), windowsAccountNumber("PC\\bob"));
  assert.ok(systemUid("win32", { USERDOMAIN: "PC" }) >= 0);
});

// ── on Windows itself (Windows CI) ───────────────────────────────────────

/**
 * A tree: root → child → grandchild, the child exits (the grandchild is an
 * orphan whose parent id names a dead process). Prints the live pids.
 */
const TREE = `
const { spawn } = require("child_process");
if (process.argv[2] === "leaf") { setInterval(() => {}, 1000); return; }
if (process.argv[2] === "middle") {
  const leaf = spawn(process.execPath, [__filename, "leaf"], { stdio: "ignore", detached: true });
  console.log("LEAF " + leaf.pid);
  setTimeout(() => process.exit(0), 300);
  return;
}
const mid = spawn(process.execPath, [__filename, "middle"], { stdio: ["ignore", "pipe", "ignore"] });
mid.stdout.on("data", (d) => process.stdout.write(d));
mid.on("exit", () => console.log("MIDDLE-GONE"));
setInterval(() => {}, 1000);
`;

async function startTree(dir: string) {
  const { spawnTree } = await import("../packages/daisy/src/platform/spawn.ts");
  const script = join(dir, "tree.cjs");
  writeFileSync(script, TREE);
  const child = spawnTree(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  const end = Date.now() + 20_000;
  while (!/MIDDLE-GONE/.test(out) && Date.now() < end) await delay(50);
  const leaf = Number(/LEAF (\d+)/.exec(out)?.[1]);
  assert.ok(leaf > 0, out);
  return { child, leaf };
}
const aliveWin = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("C-4 on Windows: stopping a harness ends its whole tree — also an orphan whose parent already exited (Job Object)", ONLY_WIN, async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-job-"));
  try {
    const { child, leaf } = await startTree(dir);
    assert.ok(aliveWin(leaf), "the orphan runs");
    const { processTree } = await import("../packages/daisy/src/platform/process-groups.ts");
    const noted = processTree(child.pid);
    assert.ok(noted.some((p) => p.pid === child.pid), "the helper is the tree's root");
    child.kill();
    const end = Date.now() + 10_000;
    while (aliveWin(leaf) && Date.now() < end) await delay(50);
    assert.equal(aliveWin(leaf), false, "the orphan went with the job");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C-4 on Windows: Daisy itself dying (killed) ends every tree it started", ONLY_WIN, async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-job2-"));
  try {
    writeFileSync(join(dir, "tree.cjs"), TREE);
    // A stand-in Daisy: starts the tree through spawnTree and prints the orphan's pid.
    const host = join(dir, "host.ts");
    writeFileSync(
      host,
      `import { spawnTree } from ${JSON.stringify(join(process.cwd(), "packages/daisy/src/platform/spawn.ts"))};
const c = spawnTree(process.execPath, [${JSON.stringify(join(dir, "tree.cjs"))}], { stdio: ["pipe", "pipe", "ignore"] });
c.stdout!.on("data", (d) => process.stdout.write(d));
setInterval(() => {}, 1000);`,
    );
    const daisy = spawn(process.execPath, ["--import", "tsx", host], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    daisy.stdout.on("data", (d) => (out += d));
    const end = Date.now() + 30_000;
    while (!/MIDDLE-GONE/.test(out) && Date.now() < end) await delay(50);
    const leaf = Number(/LEAF (\d+)/.exec(out)?.[1]);
    assert.ok(leaf > 0 && aliveWin(leaf), out);
    daisy.kill("SIGKILL");
    const until = Date.now() + 10_000;
    while (aliveWin(leaf) && Date.now() < until) await delay(50);
    assert.equal(aliveWin(leaf), false, "nothing outlives a killed Daisy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows: the process table sees this process and a child, with exact start times", ONLY_WIN, async () => {
  const { readProcTable, processName } = await import("../packages/daisy/src/platform/proc-table.ts");
  const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    await delay(300);
    const t = readProcTable();
    assert.equal(t.get(c.pid!)!.ppid, process.pid);
    assert.match(t.get(c.pid!)!.start, /^\d{17,}$/);
    assert.equal(processName(c.pid!), "node");
  } finally {
    c.kill();
  }
});

test("Windows: owner-only ACL — set on a folder, inherited by a new file, checked; a loose file is refused by readSecretFile", ONLY_WIN, async () => {
  const { restrictToOwner, ownerOnly } = await import("../packages/daisy/src/store/open.ts");
  const { readSecretFile } = await import("../packages/daisy/src/access/secret-file.ts");
  const dir = mkdtempSync(join(tmpdir(), "daisy-acl-"));
  try {
    assert.equal(restrictToOwner(dir), true);
    assert.equal(ownerOnly(dir), true);
    const f = join(dir, "secret");
    writeFileSync(f, "s3cret");
    assert.equal(ownerOnly(f), true, "inherited from the folder");
    assert.equal(readSecretFile(f), "s3cret");
    // Let Users read it: refused.
    execFileSync("icacls", [f, "/grant", "*S-1-5-32-545:(R)"], { stdio: "ignore" });
    assert.equal(ownerOnly(f), false);
    assert.throws(() => readSecretFile(f), /访问控制过宽/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows: the CLI window through ConPTY — output comes back, input goes in, the exit code is the program's", ONLY_WIN, async () => {
  const { spawnTree } = await import("../packages/daisy/src/platform/spawn.ts");
  const script = `process.stdout.write("READY\\n"); process.stdin.on("data", (d) => { if (String(d).includes("q")) process.exit(7); process.stdout.write("GOT " + d); });`;
  const child = spawnTree(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"], pty: { cols: 80, rows: 24 } });
  let text = "";
  let buf = "";
  child.stdout!.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      text += Buffer.from(m.data, "base64").toString("utf8");
    }
  });
  const code = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  const until = async (re: RegExp) => {
    const end = Date.now() + 20_000;
    while (!re.test(text) && Date.now() < end) await delay(50);
    assert.match(text, re);
  };
  await until(/READY/);
  child.stdin!.write(JSON.stringify({ cols: 100, rows: 30 }) + "\n");
  child.stdin!.write(JSON.stringify({ text: "hello\r" }) + "\n");
  await until(/GOT hello/);
  child.stdin!.write(JSON.stringify({ text: "q\r" }) + "\n");
  assert.equal(await code, 7);
});

test("Windows: the helper's own commands — version, whoami, path; the Run key is not touched by tests", ONLY_WIN, async () => {
  const { runHelper, helperExe } = await import("../packages/daisy/src/platform/windows/helper.ts");
  assert.match(runHelper(["version"]), /daisy-win 1/);
  assert.match(runHelper(["whoami"]).trim(), /^S-1-/);
  assert.equal(runHelper(["path"]).trim().toLowerCase(), helperExe().toLowerCase());
  assert.equal(readFileSync(helperExe()).subarray(0, 2).toString(), "MZ");
});

