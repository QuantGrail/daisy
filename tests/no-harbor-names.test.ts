import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * P6-05 (ADR-155): Daisy's code no longer uses the project's old name. The
 * name is left only where it must be for compatibility — the values, ids,
 * marks, environment variables, paths and storage keys that data, sessions
 * and installs from before the rename still carry — and every such use is
 * listed with its reason in tests/fixtures/legacy-names.json.
 *
 * Scanned: the code (comments aside) of the root package files, apps/,
 * scripts/ (scripts/private aside), tests/ and every package except plugin
 * packages (a plugin's names on its own external system change with that
 * system). Comments are prose; they are cleaned separately.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OLD = /harbor/gi;
const ALLOWLIST = "tests/fixtures/legacy-names.json";
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "android", "ios", ".expo", ".turbo", ".git"]);
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|css|html|py|sh|cs)$/;

type Entry = { files: string | string[]; re: string; why: string };
type Hit = { file: string; line: number; text: string };

// --- comments out, positions kept --------------------------------------
const JS_REGEX_BEFORE = new Set(
  "return typeof instanceof in of new delete void throw case do else yield await".split(" "),
);
/** JS / TS (and C# without regex literals): comments blanked, strings, templates and regexes kept. */
export function stripJs(src: string, regexLiterals = true): string {
  const out = src.split("");
  const n = src.length;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0,
    depth = 0,
    prev = "";
  const templates: number[] = [];
  const skipString = (q: string) => {
    let j = i + 1;
    while (j < n && src[j] !== q && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
    i = j + 1;
  };
  // In a template from i: up to its end, or into a `${` (code again).
  const skipTemplate = () => {
    while (i < n) {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "`") return void i++;
      else if (src[i] === "$" && src[i + 1] === "{") {
        depth++;
        templates.push(depth);
        i += 2;
        prev = "{";
        return;
      } else i++;
    }
  };
  const skipRegex = () => {
    let j = i + 1,
      cls = false;
    while (j < n && src[j] !== "\n") {
      if (src[j] === "\\") j += 2;
      else {
        if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
    }
    j++;
    while (j < n && /[a-z]/i.test(src[j]!)) j++;
    i = j;
  };
  while (i < n) {
    const c = src[i]!,
      d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = src.indexOf("\n", i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
    } else if (c === "/" && d === "*") {
      let j = src.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      skipString(c);
      prev = "str";
    } else if (c === "`") {
      i++;
      skipTemplate();
      if (prev !== "{") prev = "str";
    } else if (
      c === "/" &&
      regexLiterals &&
      (prev === "" || JS_REGEX_BEFORE.has(prev) || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev))
    ) {
      skipRegex();
      prev = "re";
    } else if (c === "}" && templates.at(-1) === depth) {
      templates.pop();
      depth--;
      i++;
      skipTemplate();
      if (prev !== "{") prev = "str";
    } else if (/\s/.test(c)) i++;
    else if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j]!)) j++;
      prev = src.slice(i, j);
      i = j;
    } else {
      if (c === "{") depth++;
      if (c === "}") depth--;
      prev = c;
      i++;
    }
  }
  return out.join("");
}
const stripBlock = (src: string, open: string, close: string) =>
  src.replace(new RegExp(`${open}[\\s\\S]*?${close}`, "g"), (m) => m.replace(/[^\n]/g, " "));
/** `#` comments of Python / shell (outside quotes on that line). */
const stripHash = (src: string) =>
  src
    .split("\n")
    .map((line) => {
      let q = "";
      for (let k = 0; k < line.length; k++) {
        const c = line[k]!;
        if (q) {
          if (c === "\\") k++;
          else if (c === q) q = "";
        } else if (c === '"' || c === "'") q = c;
        else if (c === "#") return line.slice(0, k) + " ".repeat(line.length - k);
      }
      return line;
    })
    .join("\n");
export function codeOnly(file: string, src: string): string {
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)) return stripJs(src);
  if (file.endsWith(".cs")) return stripJs(src, false);
  if (file.endsWith(".css")) return stripBlock(src, "/\\*", "\\*/");
  if (file.endsWith(".html")) return stripBlock(src, "<!--", "-->");
  if (/\.(py|sh)$/.test(file)) return stripHash(src);
  return src;
}

// --- what is scanned ----------------------------------------------------
const isPlugin = (dir: string) => {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return !!(pkg.exports && (pkg.exports["./server"] || pkg.exports["./runner"]));
  } catch {
    return false;
  }
};
function walk(root: string, dir: string, out: string[]): string[] {
  let names: string[];
  try {
    names = readdirSync(join(root, dir));
  } catch {
    return out;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const p = dir ? `${dir}/${name}` : name;
    if (statSync(join(root, p)).isDirectory()) walk(root, p, out);
    else if (CODE.test(name)) out.push(p);
  }
  return out;
}
export function scannedFiles(root = ROOT): string[] {
  const files = ["package.json", "package-lock.json"].filter((f) => existsSync(join(root, f)));
  for (const d of ["apps", "scripts", "tests"]) walk(root, d, files);
  for (const p of existsSync(join(root, "packages")) ? readdirSync(join(root, "packages")) : [])
    if (!isPlugin(join(root, "packages", p))) walk(root, `packages/${p}`, files);
  return files.filter((f) => !f.startsWith("scripts/private/") && f !== ALLOWLIST).sort();
}

// --- the check ------------------------------------------------------------
const glob = (g: string) =>
  new RegExp(
    "^" +
      g
        .split("**")
        .map((s) => s.split("*").map((t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
        .join(".*") +
      "$",
  );
export function check(
  files: { file: string; text: string }[],
  entries: Entry[],
): { hits: Hit[]; stale: Entry[] } {
  const rules = entries.map((e) => ({
    e,
    files: [e.files].flat().map(glob),
    re: new RegExp(e.re, "g"),
    used: false,
    applies: false,
  }));
  const hits: Hit[] = [];
  for (const { file, text } of files) {
    if (!/harbor/i.test(text)) continue;
    const mine = rules.filter((r) => r.files.some((g) => g.test(file)));
    for (const r of mine) r.applies = true;
    codeOnly(file, text)
      .split("\n")
      .forEach((line, i) => {
        const covered: [number, number][] = [];
        for (const r of mine)
          for (const m of line.matchAll(r.re)) {
            covered.push([m.index!, m.index! + m[0].length]);
            if (/harbor/i.test(m[0])) r.used = true;
          }
        for (const m of line.matchAll(OLD))
          if (!covered.some(([a, b]) => m.index! >= a && m.index! + 6 <= b))
            hits.push({ file, line: i + 1, text: line.trim().slice(0, 160) });
      });
  }
  // An entry whose files are here but that covers nothing must go.
  return { hits, stale: rules.filter((r) => r.applies && !r.used).map((r) => r.e) };
}

const loadEntries = (): Entry[] =>
  JSON.parse(readFileSync(join(ROOT, ALLOWLIST), "utf8")).entries;

test("P6-05 (ADR-155): the old name appears in code only where compatibility needs it, each use listed with why", () => {
  const files = scannedFiles().map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));
  assert.ok(files.length > 300, `scanned ${files.length} files`);
  const entries = loadEntries();
  const { hits, stale } = check(files, entries);
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}: ${h.text}`),
    [],
    "use a Daisy / neutral name; if old data or old installs really need it, add an entry with why to " + ALLOWLIST,
  );
  assert.deepEqual(stale.map((e) => `${[e.files].flat().join(",")}: ${e.re}`), [], "an entry that covers nothing must be removed");
  for (const e of entries) assert.ok(e.why.length >= 20, `${e.re}: say why`);
});

test("P6-05: comments are prose (not scanned); strings, identifiers, templates and regexes are", () => {
  const src = [
    "// harbor in a line comment",
    "/* Harbor in a block */ const a = 1;",
    'const b = "x"; // HarborClient is gone',
    "const HarborThing = 2;",
    "const c = `t ${d ? `harbor-${e}` : f} // no comment`;",
    "const g = x / 2; const h = /harbor_/.test(y);",
    "const i = '//'; harborVar();",
  ].join("\n");
  const code = codeOnly("a.ts", src).split("\n");
  assert.equal(code[0]!.trim(), "");
  assert.equal(code[1]!.trim(), "const a = 1;");
  assert.equal(code[2]!.trim(), 'const b = "x";');
  assert.match(code[3]!, /HarborThing/);
  assert.match(code[4]!, /harbor-\$\{e\}.*\/\/ no comment/);
  assert.match(code[5]!, /\/harbor_\//);
  assert.match(code[6]!, /harborVar/);
  assert.equal(codeOnly("a.css", "/* .harbor-x */ .daisy-y{}").trim(), ".daisy-y{}");
  assert.equal(codeOnly("a.py", 'x = "#harbor" # harbor').trim(), 'x = "#harbor"');
  const { hits, stale } = check(
    [{ file: "packages/x/src/a.ts", text: src }],
    [
      { files: "packages/*/src/*.ts", re: "/harbor_/", why: "x".repeat(20) },
      { files: "packages/*/src/*.ts", re: "harbor:", why: "x".repeat(20) },
      { files: "tests/gone.ts", re: "harbor", why: "x".repeat(20) },
    ],
  );
  assert.deepEqual(
    hits.map((h) => h.line),
    [4, 5, 7],
  );
  assert.deepEqual(stale.map((e) => e.re), ["harbor:"], "a listed file that is not here is not stale");
});
