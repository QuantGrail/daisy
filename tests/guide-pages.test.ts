import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * P6-21 (D-44 ①): the user guide is complete in both languages. docs/guide/
 * zh-CN and docs/guide/en hold the same pages under the same file names,
 * with the same section structure, each page links to its counterpart, and
 * the index lists every page in both languages.
 *
 * commands.md is generated from the command's own help (scripts/
 * gen-cli-docs.mjs) in each language (P6-23a, ADR-159 §7): it is held to
 * the same rules as the hand-written pages, and the English page has no
 * Chinese outside its link to the Chinese one.
 */
const GUIDE = join(import.meta.dirname, "..", "docs", "guide");
const pages = (lang: string) =>
  readdirSync(join(GUIDE, lang))
    .filter((f) => f.endsWith(".md"))
    .sort();
const read = (lang: string, f: string) => readFileSync(join(GUIDE, lang, f), "utf8");

/** The heading levels (## and ###) outside fenced code, in order. */
function outline(md: string): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = line.match(/^(#{2,3}) /);
    if (h) out.push(h[1].length);
  }
  return out;
}

test("every zh-CN guide page has an English counterpart and vice versa", () => {
  assert.deepEqual(pages("en"), pages("zh-CN"));
  assert.ok(pages("en").length > 2);
});

test("counterpart pages have the same sections", () => {
  for (const f of pages("zh-CN")) {
    assert.deepEqual(outline(read("en", f)), outline(read("zh-CN", f)), `${f}: the en and zh-CN section outlines differ`);
  }
});

test("each page links to its counterpart", () => {
  for (const f of pages("en")) {
    assert.ok(read("en", f).includes(`[中文](../zh-CN/${f})`), `en/${f} has no link to zh-CN/${f}`);
    assert.ok(read("zh-CN", f).includes(`[English](../en/${f})`), `zh-CN/${f} has no link to en/${f}`);
  }
});

test("the guide index lists every page in both languages", () => {
  const index = readFileSync(join(GUIDE, "README.md"), "utf8");
  for (const lang of ["zh-CN", "en"])
    for (const f of pages(lang)) assert.ok(index.includes(`](${lang}/${f})`), `docs/guide/README.md does not list ${lang}/${f}`);
});

test("P6-23a: the generated English command reference has no Chinese but the link to the Chinese page", () => {
  const text = read("en", "commands.md").replace("[中文](../zh-CN/commands.md)", "");
  const cjk = text.split("\n").filter((l) => /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/.test(l));
  assert.deepEqual(cjk, []);
});
