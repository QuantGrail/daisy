/**
 * P4N-5: the one-time passcode of a `daisy open` link — read on a fresh
 * load and on a hash change alike (a new link opened in a tab already
 * showing the page only changes the hash), cleared from the address bar,
 * and a value that cannot be a passcode said in plain words instead of the
 * server's 「参数格式错误」.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  codeFromHash,
  codeFromInput,
  codeProblem,
} from "../packages/ui/src/open-code.ts";
import { inUiLang, uiLang } from "./ui-pack.ts";

// P6-22 (ADR-159 §8): the UI speaks Chinese here (the assertions are Chinese).
uiLang("zh-CN");

const CODE = randomBytes(16).toString("base64url");

test("P4N-5: the code in a link's hash — alone, among other parts, encoded; none, empty or broken", () => {
  assert.equal(codeFromHash(`#code=${CODE}`), CODE);
  assert.equal(codeFromHash(`#x=1&code=${encodeURIComponent(CODE)}&y=2`), CODE);
  assert.equal(codeFromHash(""), null);
  assert.equal(codeFromHash("#/sessions/abc"), null);
  assert.equal(codeFromHash(undefined), null);
  // There, but nothing usable: "" (said as a problem, never sent).
  assert.equal(codeFromHash("#code="), "");
  assert.equal(codeFromHash("#code=%E0%A4%A"), "");
});

test("P4N-5: what the passcode field holds — the code, or a whole link pasted there", () => {
  assert.equal(codeFromInput(`  ${CODE} `), CODE);
  assert.equal(codeFromInput(`https://10.0.0.5:29600/#code=${CODE}`), CODE);
  assert.equal(codeFromInput(""), "");
});

test("P4N-5: a value that cannot be a passcode is said plainly before anything is sent (refused first)", () => {
  // A 6-digit PIN the browser filled in, a cut-off code, a stray character.
  for (const bad of ["123456", CODE.slice(0, 10), `${CODE}…`, "a b c d e f g h i j k"])
    assert.match(codeProblem(bad), /不是 daisy open 给的一次性口令/);
  // A link's empty `#code=` is a problem; an empty field is not (the
  // local face with the passcode off asks without one).
  assert.match(codeProblem("", true), /一次性口令/);
  assert.equal(codeProblem(""), "");
  assert.equal(codeProblem(CODE), "");
  assert.equal(codeProblem(CODE, true), "");
  // The code itself is never in the words.
  assert.ok(!codeProblem(`${CODE}!`).includes(CODE));
  // P6-22: in English too (the command's name filled in).
  inUiLang("en", () => assert.match(codeProblem("123456"), /isn't the one-time passcode daisy open gave/));
});

test("P4N-5: the web app reads the code on load and on every hash change, clears it from the address bar, and the passcode field is not a saved password", () => {
  const app = readFileSync("apps/app/App.tsx", "utf8");
  assert.match(app, /addEventListener\("hashchange", changed\)/);
  assert.match(app, /removeEventListener\("hashchange", changed\)/);
  // Both ways go through the one function that clears the hash.
  assert.equal(app.match(/= takeHashCode\(\);/g)?.length, 2);
  assert.match(app, /function takeHashCode[\s\S]*?replaceState\([\s\S]*?pathname \+ window\.location\.search/);
  // No logging anywhere near the code.
  assert.doesNotMatch(app, /console\.(log|info|warn|error|debug)/);
  const ui = readFileSync("packages/ui/src/index.tsx", "utf8");
  assert.match(ui, /autoComplete="one-time-code"/);
  assert.match(ui, /codeProblem\(typed\)/);
});
