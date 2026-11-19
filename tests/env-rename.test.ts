// P6-03 (ADR-153, D-43 ⑥): "harbor" names → "daisy" names, with the old
// ones still read / found / migrated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RENAMED_ENV,
  daisyEnv,
  envNames,
  legacyEnvName,
  legacyEnvWarning,
  setLegacyEnvWarning,
} from "../packages/contracts/src/env.ts";
import { agentBinEnv, agentCommand } from "../packages/contracts/src/acp-harnesses.ts";
import { schedulerLimits } from "../packages/daisy/src/schedule/scheduler.ts";
import { supervisedBySystemd } from "../packages/daisy/src/update/upgrade.ts";
import { childEnv } from "../packages/daisy/src/cli/local/process.ts";
import { isDaisySetting } from "../packages/daisy/src/turns/shell.ts";
import { defaultStateRoot, renamedPath } from "../packages/daisy/src/platform/paths.ts";
import { isolatedWorkspace } from "../packages/daisy/src/turns/worktrees.ts";
import { SIDECAR_SECRET_PATHS, sidecarDenyRules } from "../packages/daisy/src/turns/sidecar.ts";
import { ACP_CLIENT_INFO } from "../packages/daisy/src/harness/acp.ts";
import { legacyStorageKey, readMigrated } from "../packages/ui/src/storage-keys.ts";
import { JUMP_CONFIRM_KEY, jumpConfirmed } from "../packages/ui/src/queue-jump.ts";

const root = resolve(import.meta.dirname, "..");

/** Collects the warnings given while `f` runs (and forgets them after). */
function warnings<T>(f: () => T): { value: T; said: string[] } {
  const said: string[] = [];
  setLegacyEnvWarning((m) => said.push(m));
  try {
    return { value: f(), said };
  } finally {
    setLegacyEnvWarning();
  }
}

test("daisyEnv: DAISY_X wins; HARBOR_X is read with one warning naming both (never the value)", () => {
  const { said } = warnings(() => {
    assert.equal(daisyEnv("DAISY_ORIGINS", { DAISY_ORIGINS: "https://a.example" }), "https://a.example");
    assert.equal(
      daisyEnv("DAISY_ORIGINS", { DAISY_ORIGINS: "https://new.example", HARBOR_ORIGINS: "https://old.example" }),
      "https://new.example",
    );
    // Set to "" is set: the old name is not looked at.
    assert.equal(daisyEnv("DAISY_LIVE", { DAISY_LIVE: "", HARBOR_LIVE: "0" }), "");
    assert.equal(daisyEnv("DAISY_ORIGINS", {}), undefined);
  });
  assert.deepEqual(said, [], "no warning while the new name is used");

  const r = warnings(() => [
    daisyEnv("DAISY_ORIGINS", { HARBOR_ORIGINS: "https://secret-host.example" }),
    daisyEnv("DAISY_ORIGINS", { HARBOR_ORIGINS: "https://secret-host.example" }),
  ]);
  assert.deepEqual(r.value, ["https://secret-host.example", "https://secret-host.example"]);
  assert.equal(r.said.length, 1, "once per name");
  assert.match(r.said[0]!, /HARBOR_ORIGINS is deprecated, use DAISY_ORIGINS/);
  assert.doesNotMatch(r.said[0]!, /secret-host/);
});

test("every renamed variable works under both names, and the old one warns", () => {
  assert.ok(RENAMED_ENV.length >= 45);
  for (const name of RENAMED_ENV) {
    const old = legacyEnvName(name);
    assert.equal(old, name.replace(/^DAISY_/, "HARBOR_"));
    const fresh = warnings(() => daisyEnv(name, { [name]: "7" }));
    assert.equal(fresh.value, "7", name);
    assert.deepEqual(fresh.said, [], name);
    const legacy = warnings(() => daisyEnv(name, { [old]: "7" }));
    assert.equal(legacy.value, "7", old);
    assert.equal(legacy.said.length, 1, old);
    assert.ok(legacy.said[0]!.includes(old) && legacy.said[0]!.includes(name), old);
    assert.deepEqual(envNames(name), [name, old]);
  }
});

/** The shipped sources (not tests, not node_modules). */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "tests") sources(p, out);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("each renamed variable is read through daisyEnv, and no shipped code reads a HARBOR_ name directly", () => {
  const shipped = ["daisy", "contracts", "ui", "client", "relay", "a2a-client", "a2a-mcp"];
  const files = [
    ...shipped.flatMap((p) => sources(join(root, "packages", p))),
    ...sources(join(root, "apps/app")),
    join(root, "scripts/doctor.ts"),
  ]
    .filter((f) => !f.includes("/dist/") && !f.endsWith("contracts/src/env.ts"));
  const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
  for (const name of RENAMED_ENV) assert.ok(all.includes(`"${name}"`), `${name} is read somewhere`);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    // A direct read of an old name: process.env.HARBOR_X / env.HARBOR_X / env["HARBOR_X"].
    const direct = /\benv(?:\.|\[["'`])HARBOR_(?!DATA\b)[A-Z]/.exec(text);
    if (f.endsWith("apps/app/app.config.js")) continue; // reads both names itself (tested below)
    assert.equal(direct, null, `${f}: ${direct?.[0]}`);
  }
});

test("DAISY_<ID>_BIN replaces a harness command; HARBOR_<ID>_BIN still does (warned)", () => {
  assert.equal(agentBinEnv("kimi"), "DAISY_KIMI_BIN");
  assert.equal(agentBinEnv("claude"), "DAISY_CLAUDE_BIN");
  assert.equal(agentCommand("kimi", { DAISY_KIMI_BIN: "/n/kimi", HARBOR_KIMI_BIN: "/o/kimi" }), "/n/kimi");
  const r = warnings(() => agentCommand("antigravity", { HARBOR_ANTIGRAVITY_BIN: "/o/agy" }));
  assert.equal(r.value, "/o/agy");
  assert.match(r.said[0]!, /HARBOR_ANTIGRAVITY_BIN is deprecated, use DAISY_ANTIGRAVITY_BIN/);
});

test("readers given an environment: scheduler limits and the systemd restart switch take either name", () => {
  for (const prefix of ["DAISY_", "HARBOR_"]) {
    const { value } = warnings(() =>
      schedulerLimits({}, {
        [`${prefix}BACKGROUND_PER_NODE`]: "3",
        [`${prefix}BACKGROUND_PER_SESSION`]: "2",
        [`${prefix}MONITOR_MIN_INTERVAL_S`]: "9",
      }),
    );
    assert.deepEqual(value, { sessionBackground: 2, nodeBackground: 3, monitorMinIntervalMs: 9000 }, prefix);
    assert.equal(warnings(() => supervisedBySystemd({ [`${prefix}RUNNER_SELF_RESTART`]: "1" }, () => "x")).value, true);
    assert.equal(
      warnings(() => supervisedBySystemd({ [`${prefix}RUNNER_SELF_RESTART`]: "0", INVOCATION_ID: "i" }, () => "systemd")).value,
      false,
    );
  }
});

test("children: `daisy start` drops the self-restart switch under both names; background commands get neither Daisy's settings nor their old names", () => {
  const env = childEnv(
    { io: { env: { PATH: "/bin", DAISY_RUNNER_SELF_RESTART: "1", HARBOR_RUNNER_SELF_RESTART: "1" } }, dataDir: "/tmp/d" } as any,
    {} as any,
  );
  assert.equal(env.DAISY_RUNNER_SELF_RESTART, undefined);
  assert.equal(env.HARBOR_RUNNER_SELF_RESTART, undefined);
  assert.equal(env.DAISY_RESPAWN, "1");
  for (const k of ["HARBOR_ORIGINS", "DAISY_ORIGINS", "DAISY_CODEX_BIN", "DAISY_KIMI_BIN", "HARBOR_KIMI_BIN"])
    assert.equal(isDaisySetting(k), true, k);
  for (const k of ["DAISY_DATA", "DAISY_SESSION_ID", "PATH", "HOME"]) assert.equal(isDaisySetting(k), false, k);
});

test("the web build's sub-path: DAISY_BASE_PATH, else HARBOR_BASE_PATH with a warning", () => {
  const { basePath } = createRequire(import.meta.url)("../apps/app/app.config.js");
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => said.push(m);
  try {
    assert.equal(basePath({ DAISY_BASE_PATH: "/daisy/" }), "/daisy");
    assert.deepEqual(said, []);
    assert.equal(basePath({ HARBOR_BASE_PATH: "/old" }), "/old");
    assert.equal(basePath({ DAISY_BASE_PATH: "/new", HARBOR_BASE_PATH: "/old" }), "/new");
    assert.equal(basePath({}), "");
  } finally {
    console.warn = warn;
  }
  assert.equal(said.length, 1);
  assert.match(said[0]!, /HARBOR_BASE_PATH is deprecated, use DAISY_BASE_PATH/);
  // The same wording as every other renamed variable (daisyEnv) — its English
  // part: a build-time console line is English only (P6-22, ADR-159 §11.7).
  assert.ok(legacyEnvWarning("DAISY_BASE_PATH").startsWith(said[0]!), said[0]);
  assert.throws(() => basePath({ DAISY_BASE_PATH: "a b" }), /DAISY_BASE_PATH must be a URL path/);
});

test("on disk: new state root is daisy-runner; an existing agent-harbor one is still used", () => {
  const home = mkdtempSync(join(tmpdir(), "daisy-home-"));
  try {
    assert.equal(defaultStateRoot(home), join(home, ".local/share/daisy-runner"));
    mkdirSync(join(home, ".local/share/agent-harbor/identities"), { recursive: true });
    assert.equal(defaultStateRoot(home), join(home, ".local/share/agent-harbor"));
    mkdirSync(join(home, ".local/share/daisy-runner"), { recursive: true });
    assert.equal(defaultStateRoot(home), join(home, ".local/share/daisy-runner"));
    assert.equal(renamedPath(join(home, "nope-new"), join(home, "nope-old")), join(home, "nope-new"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("worktrees: new ones are daisy-worktrees/<sid> on daisy/<sid>; an old harbor-worktrees one is found and kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-worktrees-")),
    src = join(dir, "repo");
  mkdirSync(src);
  const git = (...args: string[]) => execFileSync("git", ["-C", src, ...args], { stdio: "pipe" }).toString().trim();
  try {
    git("init");
    writeFileSync(join(src, "a.txt"), "base");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "base");
    const common = join(src, ".git");
    // A worktree the old code made.
    mkdirSync(join(common, "harbor-worktrees"), { recursive: true });
    git("worktree", "add", "-b", "harbor/old-session", join(common, "harbor-worktrees", "old-session"), "HEAD");
    writeFileSync(join(common, "harbor-worktrees", "old-session", "work.txt"), "kept");
    const signal = new AbortController().signal;
    const old = await isolatedWorkspace(src, "old-session", signal);
    assert.equal(old.branch, "harbor/old-session");
    assert.match(old.path, /harbor-worktrees[\\/]old-session$/);
    assert.equal(readFileSync(join(old.path, "work.txt"), "utf8"), "kept");
    // A sidecar (create = false) finds it too.
    assert.equal((await isolatedWorkspace(src, "old-session", signal, undefined, false, false)).path, old.path);
    const fresh = await isolatedWorkspace(src, "new-session", signal);
    assert.equal(fresh.branch, "daisy/new-session");
    assert.match(fresh.path, /daisy-worktrees[\\/]new-session$/);
    assert.ok(statSync(join(common, "daisy-worktrees")).isDirectory());
    assert.match(git("branch", "--list"), /daisy\/new-session/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sidecar deny list: Daisy's data directory and state roots, no other product's config", () => {
  // Only Daisy's own paths and general credential paths: no other product's config directory.
  assert.ok(!SIDECAR_SECRET_PATHS.some((p) => p.startsWith("~/.config/") && !/credentials|\/gh\//.test(p)), "no product config dir");
  for (const p of [
    "~/.local/share/daisy/**",
    "~/Library/Application Support/Daisy/**",
    "~/AppData/Local/Daisy/**",
    "~/.local/share/daisy-runner/**",
    "~/.local/share/agent-harbor/**",
  ])
    assert.ok(SIDECAR_SECRET_PATHS.includes(p), p);
  const saved = process.env.DAISY_DATA;
  process.env.DAISY_DATA = "/srv/daisy-data";
  try {
    const rules = sidecarDenyRules({ profile: {} } as any);
    assert.ok(rules.includes("Read(//srv/daisy-data/**)") || rules.includes("Read(/srv/daisy-data/**)"), rules);
  } finally {
    if (saved === undefined) delete process.env.DAISY_DATA;
    else process.env.DAISY_DATA = saved;
  }
});

test("clientInfo sent to ACP and Codex says daisy", () => {
  assert.equal(ACP_CLIENT_INFO.name, "daisy");
  for (const f of ["packages/daisy/src/harness/codex.ts", "packages/daisy/src/turns/operations.ts", "packages/daisy/src/turns/login.ts"]) {
    const text = readFileSync(join(root, f), "utf8");
    assert.doesNotMatch(text, /agent_harbor|agent-harbor/, f);
    assert.match(text, /clientInfo: \{\s*name: "daisy"/, f);
  }
});

/** A Storage-like map that can be told to refuse. */
function storage(init: Record<string, string> = {}, refuse: "read" | "write" | null = null) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem(k: string) {
      if (refuse === "read") throw new Error("SecurityError");
      return m.has(k) ? m.get(k)! : null;
    },
    setItem(k: string, v: string) {
      if (refuse === "write") throw new Error("QuotaExceededError");
      m.set(k, v);
    },
    removeItem(k: string) {
      if (refuse === "write") throw new Error("QuotaExceededError");
      m.delete(k);
    },
  };
}

test("browser storage: daisy.* read first; a harbor.* value is moved on read; refusals read as nothing", () => {
  assert.equal(legacyStorageKey("daisy.auth.v1"), "harbor.auth.v1");
  const s = storage({ "harbor.auth.v1": "tok" });
  assert.equal(readMigrated(s, "daisy.auth.v1"), "tok");
  assert.deepEqual([...s.m], [["daisy.auth.v1", "tok"]]);
  assert.equal(readMigrated(s, "daisy.auth.v1"), "tok");
  // The new key wins; the old one is left alone then.
  const both = storage({ "daisy.chat.width": "900", "harbor.chat.width": "1200" });
  assert.equal(readMigrated(both, "daisy.chat.width"), "900");
  assert.equal(both.m.get("harbor.chat.width"), "1200");
  // A draft key (prefix + session id) and an explicit old key.
  const d = storage({ "harbor.draft.v1:s1": "{}" , "daisy.sidebar.harbor": "collapsed" });
  assert.equal(readMigrated(d, "daisy.draft.v1:s1"), "{}");
  assert.equal(readMigrated(d, "daisy.sidebar.sessions", "daisy.sidebar.harbor"), "collapsed");
  assert.deepEqual([...d.m.keys()].sort(), ["daisy.draft.v1:s1", "daisy.sidebar.sessions"]);
  assert.equal(readMigrated(storage({}), "daisy.auth.v1"), null);
  assert.equal(readMigrated(null, "daisy.auth.v1"), null);
  assert.equal(readMigrated(storage({ "harbor.auth.v1": "x" }, "read"), "daisy.auth.v1"), null);
  const ro = storage({ "harbor.auth.v1": "x" }, "write");
  assert.equal(readMigrated(ro, "daisy.auth.v1"), "x");
  assert.equal(ro.m.get("harbor.auth.v1"), "x");
  // A reader that uses it: the ⌘/Ctrl+Enter confirmation.
  assert.equal(JUMP_CONFIRM_KEY, "daisy.queueJump.confirmed.v1");
  const j = storage({ "harbor.queueJump.confirmed.v1": "1" });
  assert.equal(jumpConfirmed(j), true);
  assert.equal(j.m.get("daisy.queueJump.confirmed.v1"), "1");
});
