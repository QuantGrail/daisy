#!/usr/bin/env node
// P4-13 (plan 3.6 / I-5), generalized by P6-00: the core names no
// plugin. Daisy's own code — the process, the contracts, the interface, the
// client, the app shell and the relay — contains no plugin's name, path,
// command or id: a plugin lives in its own package behind the plugin seam
// (packages/daisy/src/plugins/, entry @daisy-ai/daisy/plugin) and the core
// reaches it only by the name the owner configures (DAISY_PLUGINS / `plugins`).
//
//   node scripts/check-core-names.mjs        exit 1 and list every hit
//
// Which names: every plugin package in this tree (a package.json under
// packages/* or tests/plugins/* that exports ./server or ./runner), plus the
// private plugins listed — with their own patterns and exemptions — in the
// private export manifest (scripts/private/public-manifest.json
// `privatePlugins`), which exists only in the private repository; so this
// script names none of them itself.
//
// Run by the CI's Linux job and by tests/core-names.test.ts (so the local
// gate, scripts/ci-test.mjs, runs it too). An exemption that no longer
// matches anything fails the check too, so the lists only shrink.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Core code: everything under these (generated and installed files aside). */
export const CORE_DIRS = [
  "packages/daisy",
  "packages/contracts",
  "packages/ui",
  "packages/client",
  "apps/app",
  // P5-01 (ADR-143): the relay is published on its own and serves any Daisy.
  "packages/relay",
];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "android", "ios", ".expo", ".turbo"]);
const TEXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|md|py|sh|ps1|sql|txt|css|html|yml|yaml)$/;
/** Where plugin packages live. */
const PLUGIN_PARENTS = ["packages", "tests/plugins"];
/** The private manifest (private repository only). */
export const PRIVATE_MANIFEST = "scripts/private/public-manifest.json";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The rules for `root`: [{ plugin, name, re }] and the exemptions
 * [{ file, text, why }].
 */
export function loadRules(root = ROOT) {
  const rules = [];
  const allowed = [];
  const named = new Set();
  const manifest = join(root, PRIVATE_MANIFEST);
  if (existsSync(manifest))
    for (const p of JSON.parse(readFileSync(manifest, "utf8")).privatePlugins ?? []) {
      named.add(p.package);
      for (const f of p.forbidden) rules.push({ plugin: p.package, name: f.name, re: new RegExp(f.re, f.flags ?? "") });
      for (const a of p.allowedInCore ?? []) allowed.push(a);
    }
  for (const parent of PLUGIN_PARENTS) {
    let dirs = [];
    try {
      dirs = readdirSync(join(root, parent));
    } catch {}
    for (const d of dirs) {
      const dir = `${parent}/${d}`;
      if (CORE_DIRS.includes(dir)) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
      } catch {
        continue;
      }
      const isPlugin = pkg.exports && (pkg.exports["./server"] || pkg.exports["./runner"]);
      if (!isPlugin || named.has(pkg.name)) continue;
      named.add(pkg.name);
      const short = pkg.name.replace(/^@[^/]+\//, "");
      rules.push({
        plugin: pkg.name,
        name: `the plugin ${pkg.name} (${dir}) by name, path or package`,
        re: new RegExp(`(?<![\\w-])${escape(short)}(?![\\w-])`, "i"),
      });
    }
  }
  return { rules, allowed, plugins: [...named] };
}

function walk(dir, out) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (TEXT.test(n)) out.push(p);
  }
  return out;
}

const rel = (f, root) => relative(root, f).split(sep).join("/");

/**
 * Every forbidden hit in the core under `root`, minus the exempted ones;
 * plus the exemptions that matched nothing (stale).
 */
export function scan(root = ROOT, dirs = CORE_DIRS, { rules, allowed } = loadRules(root)) {
  const hits = [];
  const used = new Set();
  for (const d of dirs)
    for (const f of walk(join(root, d), [])) {
      const file = rel(f, root);
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        const bad = rules.filter((x) => x.re.test(line));
        if (!bad.length) return;
        const ok = allowed.findIndex((a) => a.file === file && line.trim() === a.text.trim());
        if (ok >= 0) {
          used.add(ok);
          return;
        }
        hits.push({ file, line: i + 1, text: line.trim().slice(0, 200), what: bad.map((x) => x.name) });
      });
    }
  const stale = allowed.filter((_, i) => !used.has(i)).map((a) => a.file + ": " + a.text);
  return { hits, stale };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const loaded = loadRules();
  const { hits, stale } = scan(ROOT, CORE_DIRS, loaded);
  for (const h of hits) console.error(`${h.file}:${h.line}: ${h.text}\n    → ${h.what.join("; ")}`);
  for (const s of stale) console.error(`exemption matches nothing any more (remove it): ${s}`);
  if (hits.length || stale.length) {
    console.error(
      `\ncheck-core-names: ${hits.length} hit(s), ${stale.length} stale exemption(s). ` +
        "Move plugin-specific code behind the plugin seam (the plugin's own package) or word it generically.",
    );
    process.exit(1);
  }
  console.log(
    `check-core-names: the core (${CORE_DIRS.join(", ")}) names none of ${loaded.plugins.length} plugin(s) ` +
      `(${loaded.allowed.length} exemption(s)).`,
  );
}
