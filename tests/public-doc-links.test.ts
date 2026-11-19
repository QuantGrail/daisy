import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
/**
 * P6-06: every relative link in a shipped Markdown file points at a file that
 * ships too, so the public tree has no dangling links.
 *
 * In the private repository the shipped set is the tracked files that the
 * export manifest (scripts/private/public-manifest.json) marks `ship: true`.
 * In the public tree there is no manifest: every tracked file ships, and the
 * same check runs over all of them. Outside a git checkout the test skips.
 */
const ROOT = join(import.meta.dirname, "..");
const MANIFEST = join(ROOT, "scripts", "private", "public-manifest.json");

function tracked(): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
    return out.split("\0").filter((p) => p && existsSync(join(ROOT, p)));
  } catch {
    return null;
  }
}

/** The manifest's glob syntax: `**` any number of segments, `*` within one. */
function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

type Rule = { ship: boolean; re: RegExp };
function manifestRules(): Rule[] | null {
  if (!existsSync(MANIFEST)) return null;
  return (JSON.parse(readFileSync(MANIFEST, "utf8")).files as { match: string; ship: boolean }[]).map((r) => ({
    ship: r.ship,
    re: globRe(r.match),
  }));
}
const ships = (rules: Rule[] | null, p: string) => !rules || rules.find((r) => r.re.test(p))?.ship === true;

/** Relative link targets in a Markdown text, outside code: [x](t), ![x](t), [x]: t. */
export function linkTargets(md: string): { line: number; target: string }[] {
  const out: { line: number; target: string }[] = [];
  let fence: string | null = null;
  md.split("\n").forEach((raw, i) => {
    const f = raw.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const line = raw.replace(/`[^`]*`/g, "``");
    const add = (t: string) => out.push({ line: i + 1, target: t });
    for (const m of line.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'(][^)]*)?\)/g)) add(m[1].replace(/^<|>$/g, ""));
    const def = line.match(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/);
    if (def) add(def[1].replace(/^<|>$/g, ""));
  });
  return out.filter(({ target }) => target && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target));
}

/** Repository paths written as code (`docs/x.md`, `scripts/a-*.ts`) outside fenced blocks. */
export function codePaths(md: string, tops: Set<string>): { line: number; path: string }[] {
  const out: { line: number; path: string }[] = [];
  let fence: string | null = null;
  md.split("\n").forEach((raw, i) => {
    const f = raw.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    for (const m of raw.matchAll(/`([^`\s|]+)`/g)) {
      const p = m[1].replace(/[#?].*$/, "").replace(/:\d.*$/, "").replace(/[),.;:]+$/, "");
      if (p.includes("/") && tops.has(p.split("/")[0])) out.push({ line: i + 1, path: p.replace(/\/$/, "") });
    }
  });
  return out;
}

/** Generated reference pages are fixed at their source (route table, command table), not by hand. */
const generated = (text: string) => /不要手改|do not edit by hand/i.test(text.slice(0, 600));

/** Where a relative target lands (repo-relative), or null when it leaves the tree. */
export function resolveTarget(from: string, target: string): string | null {
  let t = target.replace(/[#?].*$/, "");
  try {
    t = decodeURIComponent(t);
  } catch {
    /* keep as written */
  }
  const joined = t.startsWith("/") ? posix.normalize(t.slice(1)) : posix.normalize(posix.join(posix.dirname(from), t));
  if (joined === ".." || joined.startsWith("../")) return null;
  return joined.replace(/\/$/, "") || ".";
}

const files = tracked();
const skip = files === null && "not a git checkout";

test("link parsing: inline, reference and image links; code, URLs and anchors ignored", () => {
  const md = [
    "See [a](../a.md#x) and ![img](img/p.png \"t\") and [web](https://x.test/a.md).",
    "[ref]: ./b.md",
    "`[no](c.md)` and [anchor](#top) and [mail](mailto:a@example.com)",
    "```",
    "[no](d.md)",
    "```",
    "[spaced](<e f.md>)",
  ].join("\n");
  assert.deepEqual(
    linkTargets(md).map((l) => l.target),
    ["../a.md#x", "img/p.png", "./b.md", "e f.md"],
  );
  assert.equal(resolveTarget("docs/adr/x.md", "../guide/README.md#a"), "docs/guide/README.md");
  assert.equal(resolveTarget("docs/x.md", "guide/"), "docs/guide");
  assert.equal(resolveTarget("README.md", "../outside.md"), null);
  assert.equal(resolveTarget("docs/x.md", "a%20b.md"), "docs/a b.md");
});

function shippedTree() {
  const rules = manifestRules();
  const ship = files!.filter((p) => ships(rules, p));
  const kept = files!.filter((p) => !ships(rules, p));
  const shipSet = new Set(ship);
  const dirs = new Set<string>(["."]);
  for (const p of ship) for (let d = posix.dirname(p); d !== "."; d = posix.dirname(d)) dirs.add(d);
  const docs = ship.filter((p) => p.endsWith(".md")).map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));
  return { rules, ship, kept, shipSet, dirs, docs, has: (p: string) => shipSet.has(p) || dirs.has(p) };
}

test("every relative link in a shipped Markdown file resolves to a shipped file or directory", { skip }, () => {
  const { docs, has } = shippedTree();
  const bad: string[] = [];
  for (const { file, text } of docs)
    for (const { line, target } of linkTargets(text)) {
      const to = resolveTarget(file, target);
      if (to === null) bad.push(`${file}:${line} → ${target} (leaves the repository)`);
      else if (!has(to)) bad.push(`${file}:${line} → ${target}`);
    }
  assert.deepEqual(bad, [], "a shipped doc links to a file that does not ship (or does not exist)");
});

test("a doc path written as code in a shipped doc (`docs/…`) names a shipped doc", { skip }, () => {
  const { docs, has } = shippedTree();
  const bad: string[] = [];
  for (const { file, text } of docs)
    for (const { line, path } of codePaths(text, new Set(["docs"])))
      if (!/[*<>{}$]/.test(path) && !has(path)) bad.push(`${file}:${line} → ${path}`);
  assert.deepEqual(bad, [], "point at a shipped doc, or describe the thing without a path");
});

test("shipped docs name no private file, private ADR or private doc", { skip: skip || (!existsSync(MANIFEST) && "public tree: nothing private is present") }, () => {
  const { docs, kept, ship } = shippedTree();
  const tops = new Set(files!.map((p) => p.split("/")[0]));
  const shippedAdrs = new Set(ship.map((p) => p.match(/^docs\/adr\/ADR-(\d+)-/)?.[1]).filter(Boolean));
  const shippedNames = new Set(ship.map((p) => posix.basename(p)));
  const privateDocNames = kept
    .filter((p) => p.startsWith("docs/") && p.endsWith(".md") && !shippedNames.has(posix.basename(p)))
    .map((p) => posix.basename(p));
  // A path, directory or glob is private when it names tracked files and none of them ships.
  const isPrivate = (path: string) => {
    const re = /[*?]/.test(path) ? globRe(path) : null;
    const hit = (k: string) => (re ? re.test(k) : k === path || k.startsWith(path + "/"));
    return kept.some(hit) && !ship.some(hit);
  };
  const bad: string[] = [];
  for (const { file, text } of docs) {
    for (const { line, path } of codePaths(text, tops)) if (isPrivate(path)) bad.push(`${file}:${line} → ${path}`);
    if (generated(text)) continue;
    text.split("\n").forEach((l, i) => {
      for (const m of l.matchAll(/\bADR-(\d{3})\b/g))
        if (!shippedAdrs.has(m[1])) bad.push(`${file}:${i + 1} → ADR-${m[1]} (not a shipped ADR)`);
      for (const n of privateDocNames) if (l.includes(n)) bad.push(`${file}:${i + 1} → ${n} (private doc)`);
    });
  }
  assert.deepEqual(bad, [], "describe it in the doc itself instead of pointing into the private repository");
});
