/**
 * P6-20 (ADR-159 §5): find natural-language Chinese left in source — the
 * text that still has to move into the language packs.
 *
 * Every `.ts` / `.tsx` / `.js` / `.mjs` / `.cjs` file of the shipped
 * packages and the web shell is read with comments removed (a small
 * lexer: line and block comments, strings, templates, regular
 * expressions, JSX comments); a line counts when what is left still has a
 * CJK character (a string, a template, JSX text). Tests, generated files,
 * scripts, and files the private export manifest keeps out of the public
 * tree (when it is there) are not scanned.
 *
 *   node --import tsx scripts/i18n-scan.ts              # per-area table (ADR-159's inventory)
 *   node --import tsx scripts/i18n-scan.ts --files      # per file
 *   node --import tsx scripts/i18n-scan.ts --write      # rewrite tests/i18n-pending.json from what is there now
 *
 * tests/i18n.test.ts holds every file to its entry in tests/i18n-pending.json:
 * a file not listed has none; a listed one may only go down (lower the
 * number when you convert lines, remove the entry at zero).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
export const ROOT = join(here, "..", "..");
export const PENDING_FILE = "tests/i18n-pending.json";
/**
 * P6-24: Chinese that stays in source for good, each file with its number
 * of lines and why (markers stored data or another program matches, the
 * organisation's own words a reader looks for). Not "pending".
 */
export const KEPT_FILE = "tests/i18n-kept.json";
export type Kept = Record<string, { lines: number; why: string }>;
export const readKept = (root = ROOT): Kept =>
  existsSync(join(root, KEPT_FILE)) ? JSON.parse(readFileSync(join(root, KEPT_FILE), "utf8")) : {};

/** Where shipped source lives. */
const SCAN_ROOTS = ["packages", "apps/app"];
const SKIP_DIRS = new Set(["node_modules", "dist", "tests", "__tests__", "locales", ".expo", "web-build"]);
/** The private export manifest (absent in the public tree): its `ship: false` rules are not scanned. */
const MANIFEST = "scripts/private/public-manifest.json";
const glob = (g: string) =>
  new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
function privatePaths(root: string): (rel: string) => boolean {
  if (!existsSync(join(root, MANIFEST))) return () => false;
  const rules: { re: RegExp; ship: boolean }[] = JSON.parse(readFileSync(join(root, MANIFEST), "utf8")).files.map(
    (f: { match: string; ship: boolean }) => ({ re: glob(f.match), ship: f.ship }),
  );
  return (rel) => rules.find((r) => r.re.test(rel))?.ship === false;
}
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;
const SKIP_FILE = /(\.test\.ts|\.gen\.ts|\.d\.ts)$/;
export const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;

/** Source with comments blanked (newlines kept, so line numbers hold). */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  // Template nesting: each `${` inside a template pushes the brace depth it returns at.
  const templates: number[] = [];
  let depth = 0;
  let lastSig = ""; // the last significant character (regex or division?)
  let lastWord = "";
  // Not after `<`: `</Text>` closes a JSX element. Not after a bare `>`
  // either: `<Text>/compact …</Text>` is JSX text (P6-25); after `=>`
  // (an arrow's body, `x => /re/.test(x)`) it is a pattern (lastSig "=>").
  const regexAfter = /[(,=:[!&|?{};+\-*%~^]/;
  const regexWords = new Set(["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "yield", "await", "else", "do"]);
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const readString = (q: string) => {
    let j = i + 1;
    while (j < n && src[j] !== q && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
    out += src.slice(i, j + 1);
    i = j + 1;
    lastSig = q;
  };
  const readTemplate = () => {
    // From i (just after a backtick or a closing `}` of `${`) to the template's end or a `${`.
    let j = i;
    while (j < n) {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "`") {
        out += src.slice(i, j + 1);
        i = j + 1;
        lastSig = "`";
        return;
      } else if (src[j] === "$" && src[j + 1] === "{") {
        out += src.slice(i, j + 2);
        i = j + 2;
        templates.push(depth);
        depth++;
        lastSig = "{";
        return;
      } else j++;
    }
    out += src.slice(i);
    i = n;
  };
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      out += blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      out += blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      readString(c);
      lastWord = "";
      continue;
    }
    if (c === "`") {
      out += c;
      i++;
      readTemplate();
      lastWord = "";
      continue;
    }
    if (c === "/" && (lastSig === "" || regexAfter.test(lastSig) || regexWords.has(lastWord))) {
      // A regular expression literal: to the closing `/` (classes may hold `/`).
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") j += 2;
        else {
          if (src[j] === "[") cls = true;
          else if (src[j] === "]") cls = false;
          else if (src[j] === "/" && !cls) break;
          j++;
        }
      }
      // Blanked: a pattern is matched against text, never shown.
      const closed = j < n && src[j] === "/";
      out += "/" + blank(src.slice(i + 1, j)) + (closed ? "/" : "");
      // Unclosed on its line (not a pattern after all): the newline stays.
      i = closed ? j + 1 : j;
      lastSig = "/x";
      lastWord = "";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      if (templates.length && templates[templates.length - 1] === depth - 1) {
        templates.pop();
        depth--;
        out += c;
        i++;
        readTemplate();
        continue;
      }
      depth--;
    }
    out += c;
    i++;
    if (/[A-Za-z0-9_$]/.test(c)) {
      lastWord = /[A-Za-z0-9_$]/.test(src[i - 2] ?? "") ? lastWord + c : c;
      lastSig = "a";
    } else if (!/\s/.test(c)) {
      lastSig = c === ">" && src[i - 2] === "=" ? "=>" : c;
      lastWord = "";
    }
  }
  return out;
}

/** The lines of `src` (1-based) that still carry CJK text outside comments. */
export function cjkLines(src: string): number[] {
  return stripComments(src)
    .split("\n")
    .flatMap((l, i) => (CJK.test(l) ? [i + 1] : []));
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE.test(name) && !SKIP_FILE.test(name)) out.push(p);
  }
}

/** Every scanned file (repository-relative, `/`-separated) → its CJK line count (only files with some). */
export function scan(root = ROOT): Record<string, number> {
  const files: string[] = [];
  for (const r of SCAN_ROOTS) walk(join(root, r), files);
  const counts: Record<string, number> = {};
  const isPrivate = privatePaths(root);
  for (const f of files.sort()) {
    const rel = relative(root, f).split(sep).join("/");
    if (isPrivate(rel)) continue;
    const n = cjkLines(readFileSync(f, "utf8")).length;
    if (n) counts[rel] = n;
  }
  return counts;
}

/** The area a file belongs to (ADR-159 §7: who converts it). */
export function areaOf(rel: string): string {
  if (rel.startsWith("packages/ui/") || rel.startsWith("apps/app/")) return "ui";
  if (rel.startsWith("packages/daisy/src/cli/")) return "cli";
  if (rel.startsWith("packages/daisy/src/prompts/")) return "prompts";
  if (rel.startsWith("packages/contracts/src/api/")) return "api-table";
  if (rel.startsWith("packages/contracts/")) return "contracts";
  if (rel.startsWith("packages/daisy/")) return "server";
  return rel.split("/").slice(0, 2).join("/");
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  const counts = scan();
  if (process.argv.includes("--write")) {
    const kept = readKept();
    const sorted = Object.fromEntries(
      Object.entries(counts)
        .map(([f, n]) => [f, n - (kept[f]?.lines ?? 0)] as const)
        .filter(([, n]) => n > 0)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(join(ROOT, PENDING_FILE), JSON.stringify(sorted, null, 2) + "\n");
    console.log(`wrote ${PENDING_FILE}: ${Object.keys(sorted).length} files, ${Object.values(sorted).reduce((a, b) => a + b, 0)} lines`);
  } else if (process.argv.includes("--files")) {
    for (const [f, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${f}`);
  } else {
    const by: Record<string, { files: number; lines: number }> = {};
    for (const [f, n] of Object.entries(counts)) {
      const a = (by[areaOf(f)] ??= { files: 0, lines: 0 });
      a.files++;
      a.lines += n;
    }
    for (const [a, v] of Object.entries(by).sort((x, y) => y[1].lines - x[1].lines))
      console.log(`${a.padEnd(24)} ${String(v.files).padStart(4)} files ${String(v.lines).padStart(6)} lines`);
  }
}
