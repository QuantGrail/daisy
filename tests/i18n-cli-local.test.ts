/**
 * P6-23 (ADR-159): the local commands (start / stop / open / update /
 * doctor / autostart / uninstall / watch) speak through the language packs —
 * their --help, errors and output in English, and the Chinese unchanged.
 * The other tests (cli-local, event-outlet, …) keep checking the Chinese.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_COMMANDS } from "../packages/contracts/src/index.ts";
import { loadPacks } from "../packages/contracts/src/i18n-node.ts";
import { cjkLines } from "../scripts/i18n-scan.ts";
import { daisy, fakeDaisy, testIo } from "./cli-fixture.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "daisy-i18n-local-"));
const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;
const EN = { DAISY_LANG: "en", DAISY_LOCAL_RUNNER: "0" };
const FILES = [
  "packages/daisy/src/cli/local/commands.ts",
  "packages/daisy/src/cli/local/options.ts",
  "packages/daisy/src/cli/local/watch.ts",
];

test("P6-23: the local commands' sources hold no Chinese, and every key they name is in both packs", () => {
  const packs = loadPacks().packs;
  for (const f of FILES) {
    const src = readFileSync(f, "utf8");
    assert.deepEqual(cjkLines(src), [], `${f}: Chinese left in source`);
    for (const m of src.matchAll(/(?<![\w.])t\(\s*"([a-z][\w.-]*)"/g))
      for (const lang of ["en", "zh-CN"]) assert.ok(m[1]! in packs[lang]!, `${f}: ${m[1]} is not in ${lang}`);
  }
  for (const name of LOCAL_COMMANDS)
    for (const part of ["summary", "usage", "help"])
      for (const lang of ["en", "zh-CN"]) assert.ok(`cli.local.${name}.${part}` in packs[lang]!, `cli.local.${name}.${part} (${lang})`);
});

test("P6-23: --lang en <local command> --help is English throughout; the Chinese is as before", async () => {
  const dir = tmp();
  try {
    for (const name of LOCAL_COMMANDS) {
      const r = await daisy(testIo(), dir, "--lang", "en", name, "--help");
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, new RegExp(`^Usage: daisy ${name}`));
      assert.doesNotMatch(r.out, CJK, `${name} --help has Chinese`);
      assert.doesNotMatch(r.out, /\{\w+\}/, `${name} --help has an unfilled {param}`);
    }
    let r = await daisy(testIo(), dir, "--lang", "en", "start", "--help");
    assert.match(r.out, /\[--port <port>\] \[--foreground\]/);
    assert.match(r.out, /\n {2}--port <port> {5}the local face's port/);
    r = await daisy(testIo(), dir, "--lang", "en", "open", "--help");
    assert.match(r.out, /one-time passcode/);
    assert.match(r.out, /--external {3}a link for another machine/);
    r = await daisy(testIo(), dir, "--lang", "en", "update", "--help");
    assert.match(r.out, /--source <source>/);
    assert.match(r.out, /npm:@daisy-ai\/daisy@latest/);
    assert.match(r.out, /rolls back by itself/);
    r = await daisy(testIo(), dir, "--lang", "en", "watch", "--help");
    assert.match(r.out, /--wait <seconds> {7}the longest each wait lasts \(1–\d+, default \d+\)/);
    r = await daisy(testIo(), dir, "--lang", "en", "uninstall", "--help");
    assert.match(r.out, /npm uninstall -g --prefix .* @daisy-ai\/daisy/);

    // Chinese (the tests' default): the same text as before the packs.
    r = await daisy(testIo(), dir, "start", "--help");
    assert.match(r.out, /^用法：daisy start \[--port <端口>\] \[--foreground\]/);
    assert.match(r.out, /\n {2}--port <端口> {5}指定本机面的端口/);
    r = await daisy(testIo(), dir, "watch", "--help");
    assert.match(r.out, /--wait <秒> {12}每次最多等多久（1–\d+，默认 \d+）/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P6-23: the local commands' usage errors in English (options, ports, autostart, update, watch)", async () => {
  const dir = tmp();
  try {
    const en = (...argv: string[]) => daisy(testIo({ env: EN }), dir, ...argv);
    let r = await en("start", "--bogus");
    assert.equal(r.code, 2);
    assert.match(r.err, /✗ daisy start has no option --bogus\n {2}What to do: Available options: --port, --foreground/);
    r = await en("stop", "--x");
    assert.match(r.err, /This command has no options/);
    r = await en("stop", "extra");
    assert.match(r.err, /✗ Extra arguments: extra/);
    r = await en("start", "--port");
    assert.match(r.err, /--port needs a value after it/);
    r = await en("start", "--foreground=1");
    assert.match(r.err, /--foreground takes no value/);
    r = await en("start", "--port", "80");
    assert.match(r.err, /--port takes an integer from 1024 to 65535; “80” is not one\n {2}What to do: For example --port 29420/);
    r = await en("autostart", "maybe");
    assert.match(r.err, /daisy autostart takes only on or off, not “maybe”/);
    r = await en("update", "--check", "--apply");
    assert.match(r.err, /--check and --apply can't be used together/);
    r = await en("update", "--from", "x.tgz");
    assert.match(r.err, /--from and --allow-downgrade go with --apply/);
    r = await en("watch", "--wait", "0");
    assert.match(r.err, /--wait takes an integer from 1 to \d+/);
    for (const x of [r.err]) assert.doesNotMatch(x, CJK);

    // The same in Chinese.
    r = await daisy(testIo({ env: { DAISY_LOCAL_RUNNER: "0" } }), dir, "start", "--bogus");
    assert.match(r.err, /✗ daisy start 没有选项 --bogus\n {2}怎么办：可用的选项：--port、--foreground/);
    r = await daisy(testIo({ env: { DAISY_LOCAL_RUNNER: "0" } }), dir, "update", "--check", "--apply");
    assert.match(r.err, /--check 和 --apply 不能一起用/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P6-23: the local commands' output in English (stop, open, update)", async () => {
  const dir = tmp();
  try {
    const r = await daisy(testIo({ env: EN }), dir, "stop");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "Daisy was not running.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const d = await fakeDaisy((r) => {
    if (r.path === "/api/web/open-code") return { json: { code: "c1", url: "http://127.0.0.1:1/#code=c1", expiresAt: 0 } };
    if (r.path === "/api/pin") return { json: { set: false } };
    if (r.path === "/api/update")
      return { json: { release: "0.1.0+old", supervised: true, update: { kind: "release", target: "0.1.0+new" }, request: { mode: "idle" }, summary: "a turn" } };
    if (r.path === "/api/update/restart" && r.method === "DELETE") return { json: { ok: true, cancelled: false } };
    if (r.path === "/api/catalog") return { json: { nodes: [] } };
    return undefined;
  });
  try {
    let r = await daisy(testIo({ env: { ...EN, SSH_CONNECTION: "" } }), d.dataDir, "open", "--print");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Open this link \(one-time, valid for 10 minutes, works once\):\nhttp:\/\/127\.0\.0\.1:1\/#code=c1/);
    assert.match(r.out, /⚠ No PIN is set yet/);
    assert.doesNotMatch(r.out, CJK);
    r = await daisy(testIo({ env: { ...EN, SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" } }), d.dataDir, "open");
    assert.match(r.out, /You are on this machine over SSH: .*ssh -N -L \d+:127\.0\.0\.1:\d+ <this machine>/);
    r = await daisy(testIo({ env: EN }), d.dataDir, "update");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Running: 0\.1\.0\+old/);
    assert.match(r.out, /Waiting to switch in: 0\.1\.0\+new \(newly installed\)/);
    assert.match(r.out, /Restart request: once idle, pending/);
    assert.match(r.out, /Waiting for: a turn/);
    assert.match(r.out, /Restarts by itself after exiting/);
    assert.match(r.out, /To update: daisy update --apply/);
    assert.doesNotMatch(r.out, CJK);
    r = await daisy(testIo({ env: EN }), d.dataDir, "update", "--cancel");
    assert.equal(r.out, "There is no pending restart / update request.");
    r = await daisy(testIo({ env: { DAISY_LANG: "zh-CN" } }), d.dataDir, "update", "--cancel");
    assert.equal(r.out, "没有待执行的重启 / 更新请求。");
  } finally {
    await d.close();
  }
});
