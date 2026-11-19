/**
 * P1-07: `daisy doctor` — read-only checks of this machine. It changes
 * nothing and never reads or prints a credential: the harness checks run
 * the harnesses' own status commands (`claude auth status --json`,
 * `codex login status`) and report only logged in / not, and how — for
 * this machine's own login and (N-9) for each identity Daisy logged in
 * itself (its directory under the Runner's identity root).
 */
import { daisyEnv } from "../../../../contracts/src/env.ts";
import { createServer } from "node:net";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { expectedLocalPort, givenLocalPort } from "../../access/ports.ts";
import { appliedStartSettings, startEnv, withSettings } from "../../platform/settings.ts";
import { untrustedFile } from "../../../../contracts/src/start-files.ts";
import { USER_BIN_DIRS } from "../../platform/agent-path.ts";
import {
  ACP_AGENTS,
  ACP_HARNESS_PROBLEMS,
  ACP_HARNESSES,
  acpHarness,
  agentCommand,
  harnessText,
  loadAcpHarnessFile,
  versionArgs,
} from "../../../../contracts/src/acp-harnesses.ts";
import { Daisy, health, locate, type Ctx } from "../daisy.ts";
import { CODE_ROOT, NODE_MAJOR_MIN, nodeMajor } from "../code.ts";
import { pinState } from "./process.ts";
import {
  checkClaudeAuth,
  claudeAuthMessage,
  type AuthVerdict,
} from "../../harness/claude-auth.ts";
import { autostartState, autostartSupport, lingerHint, winHelper } from "../../platform/autostart.ts";
import { findOnPath, windowsShell } from "../../platform/windows/cmdline.ts";
import { resolveSpawn } from "../../platform/spawn.ts";
import { identityHomes, ownerOnlyTree } from "../../platform/data-perms.ts";
// Not store/open.ts: the command line must not load node:sqlite (its warning would corrupt --json output).
import { isOwnerOnly } from "../../platform/windows/acl.ts";
import { t } from "../lang.ts";

export type Level = "ok" | "warn" | "fail" | "info";
export interface Check {
  name: string;
  level: Level;
  detail: string;
  fix?: string;
}

const MARK: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" };

/**
 * The harnesses Daisy drives (adapters in packages/daisy/src/harness): the
 * two native ones, then every ACP harness of acp-harnesses.ts (P4-10).
 */
/** `install`: how to install it — a pack key (`cli.doctor.install.*`) or the harness file's own text. */
export const HARNESSES: { agent: string; name: string; install: string; tier?: string }[] = [
  { agent: "claude", name: "Claude Code", install: "cli.doctor.install.claude" },
  { agent: "codex", name: "Codex", install: "npm install -g @openai/codex" },
  ...ACP_AGENTS.map((a) => {
    const h = ACP_HARNESSES[a]!;
    return { agent: a, name: h.name, install: h.install, tier: h.tier };
  }),
];


function which(bin: string, env: Ctx["io"]["env"], platform: NodeJS.Platform = process.platform): string | null {
  // P5-05: Windows — PATH × PATHEXT (claude.exe, codex.cmd …), never the current folder.
  if (platform === "win32") {
    const home = env.USERPROFILE || homedir();
    const extra = USER_BIN_DIRS.map((d) => join(home, d)).join(";");
    return findOnPath(bin, { ...env, PATH: `${env.PATH ?? env.Path ?? ""};${extra}` });
  }
  // P6-11 review: a relative path is never resolved (against this
  // command's directory or anything else) — Daisy refuses it too.
  if (bin.includes("/")) return isAbsolute(bin) && existsSync(bin) ? bin : null;
  const home = env.HOME || homedir();
  const dirs = [...(env.PATH ?? "").split(delimiter), ...USER_BIN_DIRS.map((d) => join(home, d))];
  for (const d of dirs) {
    if (!d) continue;
    const p = join(d, bin);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

async function harnessCheck(ctx: Ctx, h: (typeof HARNESSES)[number]): Promise<Check> {
  // P6-11: runner.json `agentBins` too, as the Daisy process sees it.
  const bin = which(agentCommand(h.agent, withSettings(ctx.dataDir, ctx.io.env)), ctx.io.env, ctx.io.platform);
  if (!bin)
    return {
      name: h.name,
      level: "info",
      detail: t("cli.doctor.harness.notInstalled"),
      fix: t("cli.doctor.harness.installFix", { install: harnessText(h, "install", t) }),
    };
  const v = await ctx.io.exec(...resolveSpawn(bin, versionArgs(h.agent), ctx.io.env, ctx.io.platform), { timeoutMs: 10_000 });
  const version = v.code === 0 ? v.stdout.trim().split("\n")[0]!.slice(0, 80) : "";
  if (v.code !== 0)
    return {
      name: h.name,
      level: "warn",
      detail: t("cli.doctor.harness.runFailed", { bin, args: versionArgs(h.agent).join(" "), code: String(v.code) }),
      fix: t("cli.doctor.harness.runFailedFix", { bin, args: versionArgs(h.agent).join(" ") }),
    };
  const login = await loginCheck(ctx, h.agent, bin);
  return {
    name: h.name,
    level: login.level,
    detail: t("cli.doctor.harness.detail", {
      version: version || t("cli.doctor.harness.installed"),
      tier: h.tier === "experimental" ? t("cli.doctor.harness.experimental") : "",
      login: login.detail,
    }),
    ...(login.fix ? { fix: login.fix } : {}),
  };
}

/**
 * N-9 / ADR-133: `claude auth status --json` through the same classifier
 * as a turn's preflight (a timeout, a keychain error, a non-zero exit each
 * say what they are; a passing one is asked once more). Only the verdict
 * is used: nothing of the account is printed.
 */
async function claudeAuth(
  ctx: Ctx,
  bin: string,
  env: Record<string, string | undefined>,
  configDir?: string,
): Promise<AuthVerdict> {
  return checkClaudeAuth(
    async (timeoutMs) => {
      const r = await ctx.io.exec(...resolveSpawn(bin, ["auth", "status", "--json"], ctx.io.env, ctx.io.platform), { timeoutMs, env });
      return {
        code: r.missing ? null : r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        ...(r.timedOut ? { timedOut: true } : {}),
        ...(r.missing ? { spawnError: "ENOENT" } : {}),
      };
    },
    { platform: ctx.io.platform, ...(configDir ? { configDir } : {}), sleep: (ms) => ctx.io.sleep(ms) },
  );
}

/** Credentials a Daisy-managed identity's check must not inherit (as harness/shared.ts SCRUBBED_ENV). */
const NOT_INHERITED = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
];

/**
 * The Daisy-managed Claude identities on this machine: the directories
 * `<identityRoot>/<nodeId>/<profile id>` (runner.json; identityRoot
 * defaults to `<data>/runner`, main.ts) that Claude Code has used — they
 * hold `.claude.json`. Read-only; nothing is created.
 */
export function managedClaudeDirs(dataDir: string): { id: string; dir: string }[] {
  let cfg: any;
  try {
    cfg = JSON.parse(readFileSync(join(dataDir, "runner.json"), "utf8"));
  } catch {
    return [];
  }
  const node = String(cfg?.nodeId ?? "");
  if (!/^[a-zA-Z0-9-]+$/.test(node)) return [];
  const root = join(typeof cfg.identityRoot === "string" && cfg.identityRoot ? cfg.identityRoot : join(dataDir, "runner"), node);
  let ids: string[] = [];
  try {
    ids = readdirSync(root).filter((id) => /^[a-zA-Z0-9-]+$/.test(id)).sort();
  } catch {
    return [];
  }
  return ids
    .map((id) => ({ id, dir: join(root, id) }))
    .filter(({ dir }) => {
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, ".claude.json"));
      } catch {
        return false;
      }
    });
}

/**
 * P6-15 (ADR-158, P5N-1): entries inside the data directory that group or
 * other accounts may read (Daisy takes those off at every start). The AI
 * command lines' own homes (`<identityRoot>/<nodeId>/<id>` inside it) are
 * looked at as folders only: what a harness writes there follows the mask
 * Daisy was started with (platform/umask.ts), inside a 0700 home.
 */
export function dataPermsCheck(dataDir: string): Check {
  const name = t("cli.doctor.perms.name");
  const homes = identityHomes(dataDir);
  const r = ownerOnlyTree(dataDir, { fix: false, opaque: (rel) => homes.has(rel) });
  const homesNote = homes.size ? t("cli.doctor.perms.homes", { count: homes.size }) : "";
  if (!r.loose && !r.linked && !r.truncated && !r.failed)
    return { name, level: "ok", detail: t("cli.doctor.perms.ok", { count: r.checked, homes: homesNote }) };
  const parts = [
    ...(r.loose ? [t("cli.doctor.perms.loose", { count: r.loose, examples: r.examples.slice(0, 3).join(t("cli.list.separatorShort")) })] : []),
    ...(r.linked ? [t("cli.doctor.perms.linked", { count: r.linked })] : []),
    ...(r.failed ? [t("cli.doctor.perms.failed", { count: r.failed })] : []),
    ...(r.truncated ? [t("cli.doctor.perms.truncated", { count: r.checked })] : []),
  ];
  return {
    name,
    level: r.loose || r.failed ? "warn" : "info",
    detail: t("cli.doctor.perms.detail", { parts: parts.join(t("cli.list.separator")), homes: homesNote }),
    fix: t("cli.doctor.perms.fix", { dir: dataDir }),
  };
}

async function managedClaudeChecks(ctx: Ctx): Promise<Check[]> {
  const dirs = managedClaudeDirs(ctx.dataDir);
  if (!dirs.length) return [];
  const bin = which(daisyEnv("DAISY_CLAUDE_BIN", withSettings(ctx.dataDir, ctx.io.env)) || "claude", ctx.io.env);
  const out: Check[] = [];
  for (const { id, dir } of dirs) {
    const name = t("cli.doctor.managed.name", { id: id.slice(0, 8) });
    if (!bin) {
      out.push({ name, level: "warn", detail: t("cli.doctor.managed.noBin") });
      continue;
    }
    const env: Record<string, string | undefined> = { ...ctx.io.env, CLAUDE_CONFIG_DIR: dir };
    for (const k of NOT_INHERITED) delete env[k];
    const v = await claudeAuth(ctx, bin, env, dir);
    out.push(
      v.kind === "ok"
        ? { name, level: "ok", detail: t("cli.doctor.managed.ok") }
        : {
            name,
            level: "warn",
            detail: claudeAuthMessage(v),
            ...(v.kind === "not-logged-in" || v.kind === "not-subscription"
              ? { fix: t("cli.doctor.managed.fix") }
              : {}),
          },
    );
  }
  return out;
}

/** Logged in? Only the harness's own read-only status command; no file read. */
async function loginCheck(
  ctx: Ctx,
  agent: string,
  bin: string,
): Promise<{ level: Level; detail: string; fix?: string }> {
  const how = t("cli.doctor.login.how");
  if (agent === "claude") {
    const v = await claudeAuth(ctx, bin, ctx.io.env);
    if (v.kind === "ok") return { level: "ok", detail: t("cli.doctor.login.subscription") };
    if (v.kind === "not-subscription") return { level: "ok", detail: t("cli.doctor.login.apiKey") };
    if (v.kind === "not-logged-in") return { level: "warn", detail: t("cli.doctor.login.no"), fix: how };
    if (v.kind === "failed")
      return { level: "info", detail: t("cli.doctor.login.unknown", { excerpt: v.excerpt }), fix: how };
    return { level: "warn", detail: claudeAuthMessage(v) };
  }
  if (agent === "codex") {
    const r = await ctx.io.exec(...resolveSpawn(bin, ["login", "status"], ctx.io.env, ctx.io.platform), { timeoutMs: 15_000 });
    const text = (r.stdout + r.stderr).trim();
    if (r.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text))
      return {
        level: "ok",
        detail: t("cli.doctor.login.codex", {
          how: /chatgpt/i.test(text) ? t("cli.doctor.login.chatgpt") : /api key/i.test(text) ? "API key" : t("cli.doctor.login.yes"),
        }),
      };
    return { level: "warn", detail: t("cli.doctor.login.no"), fix: how };
  }
  // P4-10: an ACP harness without an in-Daisy login says how to log in on the machine.
  const acp = acpHarness(agent);
  if (acp && !acp.login)
    return { level: "info", detail: t("cli.doctor.login.noReadOnly"), fix: t("cli.doctor.login.ifAsked", { how: harnessText(acp, "loginHint", t) }) };
  return { level: "info", detail: t("cli.doctor.login.noReadOnly"), fix: t("cli.doctor.login.ifAsked", { how }) };
}

/** Is a TCP port free on 127.0.0.1? */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen({ port, host: "127.0.0.1", exclusive: true }, () => s.close(() => resolve(true)));
  });
}

const modeOf = (p: string) => statSync(p).mode & 0o777;
const octal = (m: number) => "0" + m.toString(8);

export async function runChecks(ctx: Ctx): Promise<Check[]> {
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);

  // Node
  const major = nodeMajor();
  add(
    major >= NODE_MAJOR_MIN
      ? { name: "Node.js", level: "ok", detail: process.version }
      : {
          name: "Node.js",
          level: "fail",
          detail: t("cli.doctor.node.old", { version: process.version, min: NODE_MAJOR_MIN }),
          fix: t("cli.doctor.node.fix", { min: NODE_MAJOR_MIN }),
        },
  );

  // Data directory and its keys
  const dir = ctx.dataDir;
  if (!existsSync(dir))
    add({ name: t("cli.doctor.dataDir.name"), level: "info", detail: t("cli.doctor.dataDir.missing", { dir }) });
  else {
    const st = statSync(dir);
    const mine = process.getuid ? st.uid === process.getuid() : true;
    let writable = true;
    try {
      accessSync(dir, constants.W_OK | constants.R_OK | constants.X_OK);
    } catch {
      writable = false;
    }
    // Mode bits mean nothing on a Windows file system, whatever is asked.
    const loose = ctx.io.platform !== "win32" && process.platform !== "win32" && (st.mode & 0o077) !== 0;
    if (!mine || !writable)
      add({
        name: t("cli.doctor.dataDir.name"),
        level: "fail",
        detail: t(!mine ? "cli.doctor.dataDir.notMine" : "cli.doctor.dataDir.notWritable", { dir }),
        fix: t("cli.doctor.dataDir.accountFix"),
      });
    else if (loose)
      add({
        name: t("cli.doctor.dataDir.name"),
        level: "fail",
        detail: t("cli.doctor.dataDir.loose", { dir, mode: octal(st.mode & 0o777) }),
        fix: `chmod 700 "${dir}"`,
      });
    else if (ctx.io.platform === "win32") {
      // P5-05: the DACL (only this account, SYSTEM, Administrators).
      const acl = process.platform === "win32" ? isOwnerOnly(dir) : null;
      add(
        acl === false
          ? {
              name: t("cli.doctor.dataDir.name"),
              level: "fail",
              detail: t("cli.doctor.dataDir.aclLoose", { dir }),
              fix: t("cli.doctor.dataDir.aclFix"),
            }
          : { name: t("cli.doctor.dataDir.name"), level: acl ? "ok" : "info", detail: t(acl ? "cli.doctor.dataDir.aclOk" : "cli.doctor.dataDir.aclUnknown", { dir }) },
      );
    } else add({ name: t("cli.doctor.dataDir.name"), level: "ok", detail: t("cli.doctor.dataDir.ok", { dir, mode: octal(st.mode & 0o777) }) });
    const cred = join(dir, "keys", "cli-credential");
    if (existsSync(cred) && ctx.io.platform === "win32" && process.platform === "win32") {
      const acl = isOwnerOnly(cred);
      if (acl !== null)
        add(
          acl
            ? { name: t("cli.doctor.cred.name"), level: "ok", detail: t("cli.doctor.cred.aclOk") }
            : { name: t("cli.doctor.cred.name"), level: "fail", detail: t("cli.doctor.cred.aclLoose", { file: cred }), fix: t("cli.doctor.cred.aclFix") },
        );
    } else if (existsSync(cred) && ctx.io.platform !== "win32" && process.platform !== "win32") {
      const m = modeOf(cred);
      add(
        m & 0o077
          ? { name: t("cli.doctor.cred.name"), level: "fail", detail: t("cli.doctor.cred.loose", { file: cred, mode: octal(m) }), fix: `chmod 600 "${cred}"` }
          : { name: t("cli.doctor.cred.name"), level: "ok", detail: t("cli.doctor.cred.ok", { mode: octal(m) }) },
      );
    }
    // P6-15 (ADR-158, P5N-1): every entry inside, not just the directory.
    if (mine && writable && ctx.io.platform !== "win32" && process.platform !== "win32") add(dataPermsCheck(dir));
  }

  // P5-05: Windows — the helper (process trees, terminal, start at login,
  // owner-only files) and Git Bash (Kimi Code needs it; Claude Code uses it).
  if (ctx.io.platform === "win32") {
    const helper = winHelper();
    add(
      helper
        ? { name: t("cli.doctor.winHelper.name"), level: "ok", detail: helper }
        : {
            name: t("cli.doctor.winHelper.name"),
            level: "fail",
            detail: t("cli.doctor.winHelper.failed"),
            fix: t("cli.doctor.winHelper.fix"),
          },
    );
    const sh = windowsShell(ctx.io.env);
    add(
      sh.kind === "git-bash"
        ? { name: "Git Bash", level: "ok", detail: sh.file }
        : {
            name: "Git Bash",
            level: "warn",
            detail: t("cli.doctor.gitBash.missing"),
            fix: t("cli.doctor.gitBash.fix"),
          },
    );
  }

  // Running? port? PIN?
  const f = locate(dir);
  const up = f.state === "running" ? await health(f.rt.local.url) : null;
  if (up && f.state === "running") {
    add({ name: t("cli.doctor.daisy.name"), level: "ok", detail: t("cli.doctor.daisy.running", { pid: f.rt.pid, url: f.rt.local.url }) });
    const pin = await pinState(Daisy.connect(ctx)).catch(() => undefined);
    if (pin === null) add({ name: "PIN", level: "info", detail: t("cli.doctor.pin.none") });
    else if (pin === undefined) add({ name: "PIN", level: "warn", detail: t("cli.doctor.pin.unreadable"), fix: t("cli.doctor.pin.unreadableFix") });
    else if (!pin.set)
      add({ name: "PIN", level: "fail", detail: t("cli.doctor.pin.notSet"), fix: t("cli.doctor.pin.notSetFix") });
    else add({ name: "PIN", level: "ok", detail: t("cli.doctor.pin.set") });
  } else {
    add({
      name: t("cli.doctor.daisy.name"),
      level: "info",
      detail: f.state === "running" ? t("cli.doctor.daisy.notAnswering", { pid: f.rt.pid }) : t("cli.doctor.daisy.notRunning"),
      fix: f.state === "running" ? t("cli.doctor.daisy.restartFix") : t("cli.doctor.daisy.startFix"),
    });
    // P6-11: the same rule as the start (access/ports.ts), runner.json `port` included.
    const { port, source } = expectedLocalPort(dir, ctx.io.env);
    // P6-13: a given port the start would refuse.
    const bad = givenLocalPort(withSettings(dir, ctx.io.env)).bad;
    const free = bad ? false : await portFree(port);
    add(
      bad
        ? { name: t("cli.doctor.port.name"), level: "fail", detail: t("cli.doctor.port.bad", { bad }), fix: t("cli.doctor.port.badFix") }
        : free
        ? { name: t("cli.doctor.port.name"), level: "ok", detail: t("cli.doctor.port.free", { port, source: t(source === "given" ? "cli.doctor.port.given" : source === "remembered" ? "cli.doctor.port.remembered" : "cli.doctor.port.derived") }) }
        : {
            name: t("cli.doctor.port.name"),
            level: source === "given" ? "fail" : "warn",
            detail: t("cli.doctor.port.taken", { port }),
            fix:
              source === "given"
                ? t("cli.doctor.port.givenTakenFix")
                : t("cli.doctor.port.takenFix"),
          },
    );
  }

  // Web page
  const web = join(CODE_ROOT, "apps", "app", "dist", "index.html");
  add(
    existsSync(web)
      ? { name: t("cli.doctor.web.name"), level: "ok", detail: t("cli.doctor.web.built") }
      : {
          name: t("cli.doctor.web.name"),
          level: "warn",
          detail: t("cli.doctor.web.missing"),
          fix: t("cli.doctor.web.fix"),
        },
  );

  // P6-11: runner.json's start settings and the extra ACP harness file.
  for (const c of settingsChecks(ctx)) add(c);

  // Harnesses
  for (const h of HARNESSES) add(await harnessCheck(ctx, h));
  // N-9: the identities Daisy logged in itself, not only this machine's login.
  for (const c of await managedClaudeChecks(ctx)) add(c);
  if (!out.some((c) => HARNESSES.some((h) => h.name === c.name) && c.level === "ok"))
    add({
      name: "harness",
      level: "warn",
      detail: t("cli.doctor.harness.none"),
      fix: t("cli.doctor.harness.noneFix"),
    });

  // Start at boot
  const sup = await autostartSupport(ctx.io);
  if (!sup.ok) add({ name: t("cli.doctor.autostart.name"), level: "info", detail: sup.why });
  else {
    const st = await autostartState(ctx);
    if (!st.installed) add({ name: t("cli.doctor.autostart.name"), level: "info", detail: t("cli.doctor.autostart.off"), fix: t("cli.doctor.autostart.offFix") });
    else if (!st.enabled)
      add({ name: t("cli.doctor.autostart.name"), level: "warn", detail: t("cli.doctor.autostart.disabled", { unit: st.unit }), fix: t("cli.doctor.autostart.onFix") });
    else if (st.linger === false)
      add({ name: t("cli.doctor.autostart.name"), level: "warn", detail: t("cli.doctor.autostart.noLinger", { unit: st.unit }), fix: lingerHint() });
    else
      add({
        name: t("cli.doctor.autostart.name"),
        level: "ok",
        detail: t(st.manager === "launchd" ? "cli.doctor.autostart.launchd" : "cli.doctor.autostart.on", { unit: st.unit }),
      });
  }
  return out;
}

/**
 * P6-11 (ADR-156): what is wrong with the start settings, one line each —
 * runner.json's `port` / `acpHarnesses` / `agentBins`, and the extra ACP
 * harness file. A broken one never stops a command; the harnesses it
 * names are left out (and doctor / status say so).
 */
export function startProblems(): string[] {
  return [...(appliedStartSettings()?.problems ?? []), ...ACP_HARNESS_PROBLEMS];
}


/** runner.json's start settings and the extra ACP harness file, read now (doctor). */
export function settingsChecks(ctx: Ctx): Check[] {
  const out: Check[] = [];
  for (const p of startEnv(ctx.dataDir, ctx.io.env).problems)
    out.push({ name: t("cli.doctor.settings.name"), level: "fail", detail: p, fix: t("cli.doctor.settings.fix") });
  const env = withSettings(ctx.dataDir, ctx.io.env);
  const file = env.DAISY_ACP_HARNESSES;
  if (!file) return out;
  const own = ctx.io.env.DAISY_ACP_HARNESSES && appliedStartSettings()?.from.DAISY_ACP_HARNESSES !== ctx.io.env.DAISY_ACP_HARNESSES;
  const from = t(own ? "cli.doctor.acp.fromEnv" : "cli.doctor.acp.fromRunner");
  const r = loadAcpHarnessFile(
    file,
    (f) => readFileSync(f, "utf8"),
    (f) => untrustedFile(statSync(f), process.getuid?.()),
  );
  for (const p of r.problems)
    out.push({ name: t("cli.doctor.acp.name"), level: "fail", detail: p, fix: t("cli.doctor.acp.fix", { from }) });
  if (r.entries.length)
    out.push({
      name: t("cli.doctor.acp.name"),
      level: "ok",
      detail: t("cli.doctor.acp.ok", {
        file,
        from,
        list: r.entries.map((h) => t("cli.doctor.acp.entry", { name: h.name, id: h.id })).join(t("cli.list.separatorShort")),
      }),
    });
  return out;
}

export async function doctor(ctx: Ctx, json: boolean): Promise<number> {
  const checks = await runChecks(ctx);
  if (json) ctx.io.out(JSON.stringify(checks, null, 2));
  else {
    ctx.io.out(t("cli.doctor.title"));
    for (const c of checks) {
      ctx.io.out(t("cli.doctor.line", { mark: MARK[c.level], name: c.name, detail: c.detail }));
      if (c.fix && c.level !== "ok") ctx.io.out(t("cli.doctor.fixLine", { fix: c.fix }));
    }
  }
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}
