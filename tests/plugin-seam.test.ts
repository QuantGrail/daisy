import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { pluginSelection } from "../packages/daisy/src/plugins/runner.ts";
import { pluginPackages, root, seamChild as child } from "./fixtures/plugin-seam-run.ts";
/**
 * P1-10: the plugin seam. A plugin's code sits behind it and is off by
 * default: not enabled, none of it is loaded and a turn runs as usual
 * (I-5's spirit); enabled (`DAISY_PLUGINS=<name>` or `plugins` in the
 * config), it is all there. P6-00 (ADR-150): shown with the test plugin
 * tests/plugins/session-tag, so it holds in a tree with no other plugin; a
 * plugin package's own seam tests live in its package (packages/<name>/tests).
 */
const PLUGIN = "session-tag";
const PLUGIN_DIR = "tests/plugins/session-tag";
/** A loaded module (URL pathname) under one of these repo-relative dirs. */
const under = (f: string, dirs: string[]) => dirs.some((d) => f.replace(/\\/g, "/").includes(`/${d}/`));
const PLUGIN_DIRS = pluginPackages().map((p) => p.dir);

test("plugin selection: config wins over DAISY_PLUGINS; off is the default; bad names refused", () => {
  assert.deepEqual([...pluginSelection(undefined, undefined).keys()], []);
  assert.deepEqual([...pluginSelection(undefined, "").keys()], []);
  assert.deepEqual([...pluginSelection(undefined, " acme , ").keys()], ["acme"]);
  // A config that says anything — even nothing — is all there is.
  assert.deepEqual([...pluginSelection([], "acme").keys()], []);
  assert.deepEqual([...pluginSelection({}, "acme").keys()], []);
  const sel = pluginSelection({ acme: { socket: "/x" }, other: false }, "");
  assert.deepEqual([...sel.keys()], ["acme"]);
  assert.deepEqual(sel.get("acme"), { socket: "/x" });
  assert.deepEqual(pluginSelection({ acme: true }).get("acme"), {});
  for (const bad of ["../x", "Acme", "a/b", "server", "runner", "daisy", "x".repeat(41)])
    assert.throws(() => pluginSelection([bad]), /不合法/);
  assert.throws(() => pluginSelection(undefined, "acme,../../etc"), /不合法/);
});

test("an enabled plugin that is not installed stops start-up with a clear error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-plugin-seam-"));
  try {
    await assert.rejects(
      () => createApp({ pinGate: false, dataDir: dir, bootstrap: false, plugins: ["no-such-plugin"] }),
      /插件「no-such-plugin」没有安装/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The relative imports a source file makes, statically (no dynamic `import(expr)`). */
function imports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)|(?:^|\n)\s*import\s*["'](\.[^"']+)["']/g,
  ))
    out.push(resolve(dirname(file), m[1] ?? m[2] ?? m[3]));
  return out;
}

test("no core entry point reaches a plugin's code by a static import", () => {
  const entries = [
    "packages/daisy/src/main.ts",
    "packages/daisy/src/app.ts",
    "packages/daisy/src/turns/worker.ts",
  ].map((f) => join(root, f));
  const seen = new Set<string>(),
    todo = [...entries];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f) || !/\.(ts|tsx|mjs|js)$/.test(f) || !existsSync(f)) continue;
    seen.add(f);
    todo.push(...imports(f));
  }
  assert.ok(seen.size > 100, `walked ${seen.size} files`);
  assert.ok(seen.has(join(root, "packages/daisy/src/plugins/server.ts")));
  assert.ok(PLUGIN_DIRS.includes(PLUGIN_DIR), PLUGIN_DIRS.join(", "));
  const reached = [...seen].filter((f) => PLUGIN_DIRS.some((d) => f.startsWith(join(root, d) + sep)));
  assert.deepEqual(reached.map((f) => relative(root, f)), []);
});

test("not enabled: no plugin module is loaded, no route, no attribution — and a turn runs as usual", { timeout: 90_000 }, async () => {
  const r = await child({});
  // The log saw the core (it works), and nothing of any plugin.
  assert.ok(r.loaded.some((f) => f.endsWith("packages/daisy/src/app.ts")));
  assert.ok(r.loaded.some((f) => f.endsWith("packages/daisy/src/plugins/runner.ts")));
  assert.deepEqual(r.loaded.filter((f) => under(f, PLUGIN_DIRS)), []);
  assert.equal(r.result.status, "idle");
  assert.ok(r.result.replies.length >= 1, JSON.stringify(r.result));
  assert.equal(r.result.callbacks, 404);
  assert.equal(r.result.callbacksHttp, 404);
  assert.equal(r.result.health, 200);
  assert.ok(r.result.env.length >= 1);
  for (const e of r.result.env) assert.deepEqual(e, { DAISY_TEST_VIA: null, DAISY_TEST_SESSION: null });
});

test(`DAISY_PLUGINS=${PLUGIN}: both halves load and every harness process carries its attribution`, { timeout: 90_000 }, async () => {
  const r = await child({ DAISY_PLUGINS: PLUGIN });
  for (const f of [`${PLUGIN_DIR}/src/server.ts`, `${PLUGIN_DIR}/src/runner.ts`])
    // `loaded` holds URL pathnames ("/D:/…" on Windows), so compare by the repo-relative tail.
    assert.ok(r.loaded.some((x) => x.endsWith("/" + f)), f);
  // Only the enabled plugin.
  assert.deepEqual(r.loaded.filter((f) => under(f, PLUGIN_DIRS.filter((d) => d !== PLUGIN_DIR))), []);
  assert.equal(r.result.status, "idle");
  assert.ok(r.result.replies.length >= 1, JSON.stringify(r.result));
  // This plugin takes no events in (no hook 2): the Runner call is not there, and never an HTTP route (P1-02).
  assert.equal(r.result.callbacks, 404);
  assert.equal(r.result.callbacksHttp, 404);
  assert.ok(
    r.result.env.some((e: any) => e.DAISY_TEST_VIA === "ai" && e.DAISY_TEST_SESSION === r.result.session),
    JSON.stringify(r.result.env),
  );
});

test("I-5 / P4-13: the plugin package not installed at all — the core starts, serves and runs a turn; nothing asks for it", { timeout: 90_000 }, async () => {
  const r = await child({ PLUGIN_SEAM_UNINSTALL: PLUGIN });
  // Nothing even tried to import it (the hook logs every attempt).
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(r.loaded.filter((f) => under(f, PLUGIN_DIRS)), []);
  assert.equal(r.result.health, 200);
  assert.equal(r.result.status, "idle");
  assert.ok(r.result.replies.length >= 1, JSON.stringify(r.result));
  assert.equal(r.result.callbacks, 404);
});

test("P4-13: enabled but not installed — start-up stops and says the package is missing", { timeout: 90_000 }, async () => {
  await assert.rejects(
    () => child({ PLUGIN_SEAM_UNINSTALL: PLUGIN, DAISY_PLUGINS: PLUGIN }),
    new RegExp(`插件「${PLUGIN}」没有安装（找不到 @daisy-ai/${PLUGIN}）`),
  );
});

test("P4-13: a plugin is a package — @daisy-ai/<name> exports ./server and ./runner, and reaches the core only through @daisy-ai/daisy/plugin", () => {
  const core = JSON.parse(readFileSync(join(root, "packages/daisy/package.json"), "utf8"));
  assert.equal(core.exports["./plugin"], "./src/plugins/api.ts");
  const plugins = pluginPackages();
  assert.ok(plugins.some((p) => p.dir === PLUGIN_DIR));
  for (const { name, dir } of plugins) {
    const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    assert.match(name, /^@daisy-ai\/[a-z][a-z0-9-]*$/);
    assert.equal(pkg.exports["./server"], "./src/server.ts", name);
    assert.equal(pkg.exports["./runner"], "./src/runner.ts", name);
    for (const e of Object.values(pkg.exports) as string[]) assert.ok(existsSync(join(root, dir, e)), `${name} ${e}`);
    assert.ok(pkg.peerDependencies["@daisy-ai/daisy"], name);
    // No relative import out of the plugin's own directory.
    const src = join(root, dir, "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n)) files.push(p);
      }
    };
    walk(src);
    const out = files.flatMap((f) =>
      imports(f)
        .filter((x) => !x.startsWith(src + sep))
        .map((x) => `${relative(root, f)} → ${relative(root, x)}`.replace(/\\/g, "/")),
    );
    assert.deepEqual(out, [], name);
  }
});
