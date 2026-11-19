import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  importPlugin,
  loadRunnerPlugins,
  pluginPackage,
  pluginSelection,
} from "../packages/daisy/src/plugins/runner.ts";
import { loadServerPlugins } from "../packages/daisy/src/plugins/server.ts";
import { CODE_KEYS, readRunnerJson, readStartSettings, runnerFileDistrusted } from "../packages/daisy/src/platform/settings.ts";
import { daisy, testIo } from "./cli-fixture.ts";
import { registerHooks } from "node:module";
import { ownerOnlyTree } from "../packages/daisy/src/platform/data-perms.ts";
import { Store } from "../packages/daisy/src/store/index.ts";
import { daisy as issuerDaisy } from "./fixtures/daisy-with-issuer.ts";
import { PackageUpdate } from "../packages/daisy/src/update/package.ts";
import { stage } from "../scripts/pack-daisy.ts";
import { legacyEnvName } from "../packages/contracts/src/env.ts";
/**
 * P6-16 (D-44 ②, ADR-160): a plugin is any package the owner names in
 * runner.json `plugins` / DAISY_PLUGINS — the short form `<name>` still
 * means `@daisy-ai/<name>`; `@scope/name` is that scoped package;
 * `npm:<name>` an unscoped one. Never a path. Resolved from where Daisy is
 * installed, so `npm install -g <plugin>` next to a global Daisy is found.
 */
const POSIX = { skip: process.platform === "win32" ? "file ownership / mode: POSIX" : false };

test("plugin names: the short form is @daisy-ai/<name> as before; @scope/name and npm:<name> are those packages", () => {
  assert.deepEqual(pluginPackage("session-tag"), { name: "session-tag", pkg: "@daisy-ai/session-tag" });
  // The own scope written in full is the same plugin as its short name.
  assert.deepEqual(pluginPackage("@daisy-ai/session-tag"), { name: "session-tag", pkg: "@daisy-ai/session-tag" });
  assert.deepEqual(pluginPackage("@acme/daisy-foo"), { name: "@acme/daisy-foo", pkg: "@acme/daisy-foo" });
  assert.deepEqual(pluginPackage(" @acme/daisy.foo_2 "), { name: "@acme/daisy.foo_2", pkg: "@acme/daisy.foo_2" });
  assert.deepEqual(pluginPackage("npm:daisy-plugin-foo"), { name: "npm:daisy-plugin-foo", pkg: "daisy-plugin-foo" });
  assert.deepEqual(pluginPackage("npm:@acme/daisy-foo"), { name: "@acme/daisy-foo", pkg: "@acme/daisy-foo" });
  // An unscoped package never takes a short name's place (`npm:my-plugin` is not `my-plugin`).
  assert.notEqual(pluginPackage("npm:my-plugin").name, pluginPackage("my-plugin").name);
  // Selection: config and environment take every form; one plugin, one entry.
  const sel = pluginSelection({ "@acme/daisy-foo": { x: 1 }, "npm:daisy-plugin-bar": true, "session-tag": false }, "");
  assert.deepEqual([...sel.keys()], ["@acme/daisy-foo", "npm:daisy-plugin-bar"]);
  assert.deepEqual(sel.get("@acme/daisy-foo"), { x: 1 });
  assert.deepEqual(
    [...pluginSelection(undefined, "session-tag, @acme/daisy-foo ,npm:daisy-plugin-bar").keys()],
    ["session-tag", "@acme/daisy-foo", "npm:daisy-plugin-bar"],
  );
  assert.deepEqual([...pluginSelection(["session-tag", "@daisy-ai/session-tag"]).keys()], ["session-tag"]);
});

test("plugin names: anything else is refused — paths, URLs, other schemes, upper case, Daisy's own packages, Node's built-ins", () => {
  for (const bad of [
    "../x",
    "./x",
    "/abs/plugin",
    "C:\\plugins\\x",
    "x\\y",
    "file:///tmp/x",
    "file:x",
    "node:fs",
    "https://example.invalid/x.tgz",
    "git+ssh://example.invalid/x",
    "a/b",
    "daisy-plugin-foo/server",
    "Acme",
    "@Acme/x",
    "@acme",
    "@acme/",
    "@/x",
    "@acme/x/y",
    "@acme/../x",
    "@acme/.x",
    "@acme/_x",
    "npm:",
    "npm:../x",
    "npm:/abs",
    "npm:.hidden",
    "npm:_x",
    "npm:Foo",
    "npm:a b",
    "npm:fs",
    "npm:child_process",
    "npm:node_modules",
    "npm:x/y",
    "npm:npm:x",
    "server",
    "runner",
    "daisy",
    "relay",
    "@daisy-ai/daisy",
    "@daisy-ai/contracts",
    "app",
    "@daisy-ai/app",
    "@daisy-ai/daisy.",
    "@acme/foo.",
    "npm:foo.",
    "x".repeat(41),
    `@acme/${"x".repeat(210)}`,
  ])
    assert.throws(() => pluginSelection([bad]), /不合法/, bad);
  assert.throws(() => pluginSelection(undefined, "session-tag,../../etc"), /不合法/);
  assert.throws(() => pluginSelection({ "/opt/evil": true }), /不合法/);
});

test("the short form still loads the plugin it always did; @daisy-ai/<name> written in full is the same plugin", async () => {
  const server = await loadServerPlugins(["@daisy-ai/session-tag"], { store: {} as any });
  assert.deepEqual(server.names, ["session-tag"]);
  const list = await loadRunnerPlugins(pluginSelection(undefined, "session-tag"), {
    api: async () => ({}),
    stateRoot: tmpdir(),
    stateKey: "k",
    user: "me",
    log: () => {},
  });
  assert.deepEqual(list.map((p) => p.name), ["session-tag"]);
});

test("a plugin installed next to a global npm install of Daisy is found there — scoped, unscoped and short form; one that is not there is not installed", { timeout: 60_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "daisy-plugin-prefix-")));
  try {
    // npm's global layout: <prefix>/lib/node_modules (Windows: <prefix>/node_modules).
    const nm = process.platform === "win32" ? join(root, "prefix", "node_modules") : join(root, "prefix", "lib", "node_modules");
    const daisyDir = join(nm, "@daisy-ai", "daisy");
    stage(daisyDir, { web: false });
    const plugin = (pkg: string, reports: string, sides: ("server" | "runner")[]) => {
      const dir = join(nm, ...pkg.split("/"));
      mkdirSync(dir, { recursive: true });
      const exports: Record<string, string> = {};
      for (const side of sides) {
        exports[`./${side}`] = `./${side}.mjs`;
        const make = side === "server" ? "createServerPlugin" : "createRunnerPlugin";
        writeFileSync(
          join(dir, `${side}.mjs`),
          [
            "export const where = import.meta.url;",
            // Its peer, @daisy-ai/daisy, is reachable from it the same way.
            'export const daisy = import.meta.resolve("@daisy-ai/daisy/package.json");',
            `export function ${make}(host) {`,
            `  return { name: ${JSON.stringify(reports)}, sessionEnv: () => ({ OPT: String(host.options.opt ?? "") }) };`,
            "}",
          ].join("\n"),
        );
      }
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0", type: "module", exports }));
    };
    plugin("@acme/daisy-foo", "@acme/daisy-foo", ["server", "runner"]);
    plugin("daisy-plugin-bar", "daisy-plugin-bar", ["server", "runner"]);
    plugin("@daisy-ai/old-style", "old-style", ["server", "runner"]);
    plugin("@acme/half", "@acme/half", ["server"]);
    // Daisy's own plugin loader, as installed in that prefix.
    const seam: typeof import("../packages/daisy/src/plugins/runner.ts") = await import(
      pathToFileURL(join(daisyDir, "packages", "daisy", "src", "plugins", "runner.ts")).href
    );
    const prefixUrl = pathToFileURL(nm).href;
    for (const name of ["@acme/daisy-foo", "npm:daisy-plugin-bar", "old-style"]) {
      const m: any = await seam.importPlugin(name, "server");
      assert.ok(String(m.where).startsWith(prefixUrl + "/"), `${name}: ${m.where}`);
      assert.equal(m.daisy, pathToFileURL(join(daisyDir, "package.json")).href);
    }
    const list = await seam.loadRunnerPlugins(
      seam.pluginSelection({ "@acme/daisy-foo": { opt: "a" }, "npm:daisy-plugin-bar": { opt: "b" }, "old-style": true }),
      { api: async () => ({}), stateRoot: root, stateKey: "k", user: "me", log: () => {} },
    );
    assert.deepEqual(list.map((p) => p.name), ["@acme/daisy-foo", "daisy-plugin-bar", "old-style"]);
    assert.deepEqual(list.map((p) => p.sessionEnv?.({ id: "s", agent: "codex" })), [{ OPT: "a" }, { OPT: "b" }, { OPT: "" }]);
    // Not in that prefix (only in this checkout): not installed for that Daisy.
    await assert.rejects(seam.importPlugin("session-tag", "server"), /插件「session-tag」没有安装（找不到 @daisy-ai\/session-tag）/);
    await assert.rejects(seam.importPlugin("npm:daisy-plugin-gone", "server"), /插件「npm:daisy-plugin-gone」没有安装（找不到 daisy-plugin-gone）/);
    await assert.rejects(seam.importPlugin("@acme/half", "runner"), /插件「@acme\/half」没有 Runner 端（@acme\/half 没有导出 \.\/runner）/);
    // Review L1 / L2: only from where Daisy is installed. A package Node would
    // find further up (here <root>/prefix/node_modules — like C:\node_modules,
    // which any account may create on Windows) is not taken …
    const above = join(root, "prefix", "node_modules", "@acme", "above");
    mkdirSync(above, { recursive: true });
    writeFileSync(join(above, "package.json"), JSON.stringify({ name: "@acme/above", type: "module", exports: { "./server": "./server.mjs" } }));
    writeFileSync(join(above, "server.mjs"), 'export function createServerPlugin() { return { name: "@acme/above" }; }');
    await assert.rejects(seam.importPlugin("@acme/above", "server"), /插件「@acme\/above」没有安装（找不到 @acme\/above）/);
    // … and one installed there but resolved somewhere else (a tsconfig `paths`
    // mapping, a resolve hook) is refused.
    plugin("@acme/redirected", "@acme/redirected", ["server"]);
    const elsewhere = join(root, "elsewhere.mjs");
    writeFileSync(elsewhere, 'export function createServerPlugin() { return { name: "@acme/redirected" }; }');
    registerHooks({
      resolve: (specifier, context, next) =>
        specifier === "@acme/redirected/server" ? { url: pathToFileURL(elsewhere).href, shortCircuit: true } : next(specifier, context),
    });
    await assert.rejects(seam.importPlugin("@acme/redirected", "server"), /@acme\/redirected.*outside where Daisy is installed/);
    // The name it reports must be the one it was enabled by (or its package's).
    plugin("@acme/liar", "something-else", ["runner"]);
    await assert.rejects(
      seam.loadRunnerPlugins(seam.pluginSelection(["@acme/liar"]), { api: async () => ({}), stateRoot: root, stateKey: "k", user: "me", log: () => {} }),
      /插件「@acme\/liar」报的名字是「something-else」/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("this checkout: an enabled plugin that is not installed stops start-up, named by its package", async () => {
  await assert.rejects(importPlugin("@acme/not-installed", "server"), /插件「@acme\/not-installed」没有安装（找不到 @acme\/not-installed）/);
  await assert.rejects(importPlugin("npm:daisy-plugin-not-installed", "runner"), /没有安装（找不到 daisy-plugin-not-installed）/);
});

// ── what code runs is the owner's alone ─────────────────────────────────

const writeRunner = (dir: string, v: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runner.json"), typeof v === "string" ? v : JSON.stringify(v), { mode: 0o600 });
  chmodSync(join(dir, "runner.json"), 0o600);
};

test("runner.json as Daisy reads it: absent, trusted; another account's or writable by others — nothing from it, before parsing; not JSON — one line, no text", POSIX, () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-p616-"));
  try {
    assert.deepEqual(readRunnerJson(dir), { config: null });
    const all = { nodeId: "n1", concurrency: 4, plugins: ["@acme/daisy-foo"], updateSource: "/opt/daisy-releases", autoUpdate: true, identityRoot: "/tmp/x", workspaceHome: "/tmp/y", allowedRoots: ["/"] };
    writeRunner(dir, all);
    assert.deepEqual(readRunnerJson(dir), { config: all });
    assert.equal(runnerFileDistrusted(dir), null);
    chmodSync(join(dir, "runner.json"), 0o664);
    const r = readRunnerJson(dir);
    assert.match(r.distrust!, /别的账户能改它/);
    // Review M2: nothing of it is used (identity homes, workspaces, plugins, updates).
    assert.equal(r.config, null);
    assert.deepEqual([...CODE_KEYS].sort(), ["autoUpdate", "plugins", "updateSource"]);
    assert.match(readStartSettings(dir).problems.join("\n"), /别的账户能改它/);
    // Review L4: judged before it is parsed — a writer of a distrusted file cannot make it "broken".
    writeFileSync(join(dir, "runner.json"), "{ not json");
    chmodSync(join(dir, "runner.json"), 0o666);
    assert.deepEqual(Object.keys(readRunnerJson(dir)).sort(), ["config", "distrust"]);
    // Not JSON: one line saying where — never the file's text.
    writeRunner(dir, '{ "nodeId": "n1", "secret-ish": "SHOULD-NOT-SHOW" ');
    const b = readRunnerJson(dir);
    assert.equal(b.config, null);
    assert.match(b.broken!, /runner\.json.*(不是合法 JSON|没有写完)/);
    assert.doesNotMatch(b.broken!, /SHOULD-NOT-SHOW|\n/);
    writeRunner(dir, "[1,2]");
    assert.ok(readRunnerJson(dir).broken);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review L3: a runner.json that cannot be looked at is distrusted, not trusted (stat errors do not fail open)", POSIX, () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-p616-"));
  const dir = join(root, "data");
  try {
    writeRunner(dir, { nodeId: "n1", plugins: ["@acme/daisy-foo"] });
    chmodSync(dir, 0o000);
    if (process.getuid?.() === 0) return; // root reads anything
    assert.ok(runnerFileDistrusted(dir), "unreadable directory: distrusted");
    const r = readRunnerJson(dir);
    assert.equal(r.config, null);
    assert.match(r.distrust!, /EACCES/);
  } finally {
    chmodSync(dir, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("review M1: the start's permission walk leaves a group / other-writable runner.json as it is (tightening it would make it trusted) and says so", POSIX, () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-p616-"));
  try {
    writeRunner(dir, { nodeId: "n1" });
    writeFileSync(join(dir, "other.txt"), "x");
    chmodSync(join(dir, "runner.json"), 0o664);
    chmodSync(join(dir, "other.txt"), 0o664);
    const r = ownerOnlyTree(dir, { fix: true, leave: (rel, st) => rel === "runner.json" && (st.mode & 0o022) !== 0 });
    assert.equal(statSync(join(dir, "runner.json")).mode & 0o777, 0o664, "left");
    assert.equal(statSync(join(dir, "other.txt")).mode & 0o777, 0o600, "the rest tightened");
    assert.deepEqual(r.left, ["runner.json"]);
    // The store's start does the same.
    const st = new Store(dir);
    st.close();
    assert.equal(statSync(join(dir, "runner.json")).mode & 0o777, 0o664);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`daisy update --check` (Daisy stopped) does not take updateSource from a runner.json others can write", POSIX, async () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-p616-"));
  try {
    const data = join(root, "data");
    const releases = join(root, "releases");
    mkdirSync(releases);
    writeRunner(data, { updateSource: releases });
    const env = { ...clean(process.env), HOME: root };
    // Trusted: the directory is the source (nothing newer in it).
    let r = await daisy(testIo({ env }), data, "update", "--check");
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /已是最新/);
    chmodSync(join(data, "runner.json"), 0o666);
    r = await daisy(testIo({ env }), data, "update", "--check");
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.err, /别的账户能改它.*updateSource 没有采用/);
    assert.match(r.err, /没有设置更新来源/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PUT /api/update/source (with the PIN) does not rewrite a runner.json others can write — it would make what they wrote the owner's", POSIX, async () => {
  const s = await issuerDaisy();
  const root = mkdtempSync(join(tmpdir(), "daisy-p616-"));
  try {
    const code = join(root, "prefix", "lib", "node_modules", "@daisy-ai", "daisy");
    mkdirSync(code, { recursive: true });
    writeFileSync(join(code, ".release"), "0.1.0+aaa\n");
    s.ctx.packageUpdate = new PackageUpdate({ codeRoot: code, dataDir: s.dir, own: "0.1.0+aaa", auto: true, restartable: () => true, backup: () => null, log: () => {} });
    const file = join(s.dir, "runner.json");
    const before = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...before, plugins: ["@acme/planted"] }));
    chmodSync(file, 0o666);
    const text = readFileSync(file, "utf8");
    const put = await s.ctx.app.inject({ method: "PUT", url: "/api/update/source", headers: s.withPin(), payload: { source: "off" } });
    assert.equal(put.statusCode, 409, put.body);
    assert.equal(put.json().code, "runner_json_untrusted");
    assert.match(put.json().error ?? put.json().message, /别的账户能改它/);
    assert.equal(readFileSync(file, "utf8"), text, "not rewritten");
    assert.equal(statSync(file).mode & 0o777, 0o666);
    // Fixed (owner-only): it is written as before.
    chmodSync(file, 0o600);
    const ok = await s.ctx.app.inject({ method: "PUT", url: "/api/update/source", headers: s.withPin(), payload: { source: "off" } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).updateSource, "off");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).nodeId, before.nodeId, "the rest kept");
    // Review L6: not valid JSON — refused, never rewritten as only { updateSource } (that wiped nodeId).
    writeFileSync(file, '{ "nodeId": "' + before.nodeId + '", ');
    const broken = readFileSync(file, "utf8");
    const bad = await s.ctx.app.inject({ method: "PUT", url: "/api/update/source", headers: s.withPin(), payload: { source: "off" } });
    assert.equal(bad.statusCode, 409, bad.body);
    assert.equal(bad.json().code, "runner_json_broken");
    assert.equal(readFileSync(file, "utf8"), broken, "not rewritten");
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => ok(p));
    });
  });

/** Everything a child must not inherit from this shell (new names, their old ones, PORT). */
function clean(from: Record<string, string | undefined>): Record<string, string | undefined> {
  const env = { ...from };
  const old = legacyEnvName("DAISY_");
  for (const k of Object.keys(env)) if (k.startsWith("DAISY_") || k.startsWith(old) || k === "PORT") delete env[k];
  return env;
}

/** Start the Daisy process on `data` (no Runner); its output and how it ended. */
async function startDaisy(root: string, data: string, untilRuntime: boolean) {
  const child = spawn(process.execPath, ["--import", "tsx", resolve("packages/daisy/src/main.ts")], {
    env: { ...clean(process.env), HOME: root, DAISY_DATA: data, DAISY_PORT: String(await freePort()), DAISY_LOCAL_RUNNER: "0" } as unknown as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  const exited = new Promise<number | null>((ok) => child.once("exit", (c) => ok(c)));
  const runtime = join(data, "runtime.json");
  if (untilRuntime)
    for (let i = 0; i < 600 && !existsSync(runtime) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100));
  return {
    out: () => out,
    runtime,
    exited,
    stop: async () => {
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 20_000))]);
    },
  };
}

test("the Daisy process: a runner.json others can write stops the start before anything is set up — nothing of it used, it is not tightened (review M1, M2, L5)", { ...POSIX, timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-p616-"));
  const data = join(root, "data");
  // Planted: plugins, an update source switched on, identity homes and workspaces elsewhere.
  writeRunner(data, { nodeId: "n1", plugins: ["@acme/not-installed"], updateSource: root, autoUpdate: true, identityRoot: join(root, "theirs"), workspaceHome: root, allowedRoots: ["/"] });
  chmodSync(join(data, "runner.json"), 0o666);
  const d = await startDaisy(root, data, false);
  try {
    const code = await Promise.race([d.exited, new Promise<"hung">((r) => setTimeout(() => r("hung"), 60_000))]);
    assert.equal(code, 1, d.out());
    assert.match(d.out(), /✗ .*runner\.json.*别的账户能改它.*not starting/);
    assert.doesNotMatch(d.out(), /没有安装|    at /);
    assert.equal(existsSync(join(data, "daisy.sqlite")), false, "nothing set up");
    assert.equal(existsSync(join(data, "update")), false, "no updater");
    assert.equal(statSync(join(data, "runner.json")).mode & 0o777, 0o666, "not tightened into a trusted file");
  } finally {
    await d.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Daisy process: a runner.json that is not valid JSON stops the start with one line saying where (not a stack)", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-p616-"));
  const data = join(root, "data");
  writeRunner(data, '{ "nodeId": "n1",\n  "plugins": [ ');
  const d = await startDaisy(root, data, false);
  try {
    const code = await Promise.race([d.exited, new Promise<"hung">((r) => setTimeout(() => r("hung"), 60_000))]);
    assert.equal(code, 1, d.out());
    assert.match(d.out(), /✗ .*runner\.json.*(不是合法 JSON|没有写完).*not starting/);
    assert.doesNotMatch(d.out(), /SyntaxError|    at /);
    assert.equal(existsSync(join(data, "daisy.sqlite")), false, "nothing set up");
  } finally {
    await d.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
