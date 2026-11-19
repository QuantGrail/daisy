/**
 * P5-06 (ADR-145): updating an npm-installed Daisy — the pieces, without
 * npm: who may ask (refused first), where the install is, reading a
 * package, versions, the switch (backup → way back → install → smoke →
 * pending) with its failures, the idle wait, the start guard's trial /
 * confirmation / rollback, the background process restarting itself, and
 * `daisy uninstall`'s per-system hooks (Windows: P5-05's stub).
 *
 * The real thing — packed versions installed with npm, upgraded with the
 * data kept, a broken one rolled back — is tests/package-update-e2e.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  PackageUpdate,
  MAX_STARTS,
  compareVersions,
  globalPrefix,
  keptPackage,
  latestFrom,
  uninstallCommand,
  npmCommand,
  parseSource,
  readPackage,
  readPending,
  readState,
  writePending,
  nodeAutoUpdate,
  type PackageStatus,
  type Pending,
} from "../packages/daisy/src/update/package.ts";
import { StartGuard, comeback, decideGuard } from "../packages/daisy/src/update/guard.ts";
import { supervision } from "../packages/daisy/src/update/restart.ts";
import { backupForUpdate } from "../packages/daisy/src/store/open.ts";
import { autostartHooks, supervisorName, windowsHooks } from "../packages/daisy/src/platform/autostart-hooks.ts";
import { daisy as issuerDaisy, runningTurn } from "./fixtures/daisy-with-issuer.ts";
import { daisy, testIo } from "./cli-fixture.ts";
import { autoUpdateLine } from "../packages/ui/src/settings-view.ts";
import { uiLang } from "./ui-pack.ts";
import { DatabaseSync } from "node:sqlite";

uiLang("zh-CN");

const tmp = () => mkdtempSync(join(tmpdir(), "daisy-pkgupd-"));

/** A minimal npm tarball: package/package.json and package/.release. */
function tgz(file: string, o: { name?: string; version: string; release?: string | null; guard?: boolean }) {
  const blocks: Buffer[] = [];
  const add = (name: string, body: string) => {
    const data = Buffer.from(body);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  };
  // P5-06: our packages say they carry the start guard (pack-daisy.ts).
  add("package/package.json", JSON.stringify({ name: o.name ?? "@daisy-ai/daisy", version: o.version, ...(o.guard === false ? {} : { daisy: { updateGuard: 1 } }) }));
  if (o.release !== null) add("package/.release", (o.release ?? `${o.version}+abc`) + "\n");
  blocks.push(Buffer.alloc(1024));
  writeFileSync(file, gzipSync(Buffer.concat(blocks)));
  return file;
}

/** An npm global layout: <root>/prefix/lib/node_modules/@daisy-ai/daisy (Windows: no lib) with a .release. */
function install(root: string, release: string) {
  const code = join(root, "prefix", ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "@daisy-ai", "daisy");
  mkdirSync(code, { recursive: true });
  writeFileSync(join(code, ".release"), release + "\n");
  return code;
}

// ── who may ask (refused first, §10.2) ─────────────────────────────────

test("refused first: the AI's working credential, no credential and a stranger's token never check or apply an update; the owner gets 409 where this Daisy cannot update itself", async () => {
  const s = await issuerDaisy();
  try {
    const t = await runningTurn(s);
    for (const url of ["/api/update/check", "/api/update/apply"]) {
      const ai = await s.ctx.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${t.ai}` }, payload: {} });
      assert.ok([401, 403].includes(ai.statusCode), `${url} AI: ${ai.statusCode}`);
      const none = await s.ctx.app.inject({ method: "POST", url, payload: {} });
      assert.equal(none.statusCode, 401, `${url} none`);
      const other = await s.tokenFor("user:someone-else");
      await s.configure();
      const o = await s.ctx.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${other}` }, payload: {} });
      assert.ok([401, 403].includes(o.statusCode), `${url} other: ${o.statusCode}`);
      // The owner, on a Daisy built without an updater (a checkout, a test app).
      const own = await s.ctx.app.inject({ method: "POST", url, headers: s.asCli, payload: {} });
      assert.equal(own.statusCode, 409, own.body);
      assert.equal(own.json().code, "update_unavailable");
    }
    // A body that names something else is refused before anything runs.
    const bad = await s.ctx.app.inject({ method: "POST", url: "/api/update/apply", headers: s.asCli, payload: { from: "/x.tgz", run: "rm" } });
    assert.equal(bad.statusCode, 400);
  } finally {
    await s.close();
  }
});

test("the owner applies a package file: accepted with what it waits for, audited; status shows it; cancel withdraws it", async () => {
  const s = await issuerDaisy();
  const root = tmp();
  try {
    const code = install(root, "0.1.0+aaa");
    const file = tgz(join(root, "daisy-ai-daisy-0.2.0.tgz"), { version: "0.2.0", release: "0.2.0+bbb" });
    s.ctx.packageUpdate = new PackageUpdate({
      codeRoot: code,
      dataDir: s.dir,
      own: "0.1.0+aaa",
      auto: false,
      source: "off",
      restartable: () => true,
      backup: () => null,
      log: () => {},
    });
    const r = await s.ctx.app.inject({ method: "POST", url: "/api/update/apply", headers: s.asCli, payload: { from: file } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().package.available.release, "0.2.0+bbb");
    assert.equal(r.json().package.requested, true);
    assert.equal(r.json().package.state, "waiting");
    const st = await s.ctx.app.inject({ url: "/api/update", headers: s.asCli });
    assert.equal(st.json().package.available.release, "0.2.0+bbb");
    const audit = s.ctx.store.all("SELECT action,target FROM audit WHERE action='update.request'") as any[];
    assert.equal(audit.length, 1);
    assert.match(audit[0].target, /0\.2\.0\+bbb/);
    // Older than running: refused without allowDowngrade.
    const old = tgz(join(root, "old.tgz"), { version: "0.0.9", release: "0.0.9+zzz" });
    const r2 = await s.ctx.app.inject({ method: "POST", url: "/api/update/apply", headers: s.asCli, payload: { from: old } });
    assert.equal(r2.statusCode, 409);
    assert.match(r2.json().error, /旧.*--allow-downgrade/);
    // Not a Daisy package: refused.
    const other = tgz(join(root, "other.tgz"), { name: "left-pad", version: "9.9.9" });
    const r3 = await s.ctx.app.inject({ method: "POST", url: "/api/update/apply", headers: s.asCli, payload: { from: other } });
    assert.equal(r3.statusCode, 409);
    assert.match(r3.json().error, /不是 @daisy-ai\/daisy/);
    // No .release (not made by the packer): refused — the guard tells releases apart by it.
    const bare = tgz(join(root, "bare.tgz"), { version: "0.3.0", release: null });
    const r4 = await s.ctx.app.inject({ method: "POST", url: "/api/update/apply", headers: s.asCli, payload: { from: bare } });
    assert.equal(r4.statusCode, 409);
    assert.match(r4.json().error, /版本标记/);
    // The same version, another build: no telling which is newer — only with --allow-downgrade.
    const sameVer = tgz(join(root, "same.tgz"), { version: "0.1.0", release: "0.1.0+ccc" });
    const r5 = await s.ctx.app.inject({ method: "POST", url: "/api/update/apply", headers: s.asCli, payload: { from: sameVer } });
    assert.equal(r5.statusCode, 409);
    assert.match(r5.json().error, /版本号相同、构建不同.*--allow-downgrade/);
    const r5b = await s.ctx.app.inject({ method: "POST", url: "/api/update/apply", headers: s.asCli, payload: { from: sameVer, allowDowngrade: true } });
    assert.equal(r5b.statusCode, 200, r5b.body);
    // The identical build: 已是最新 / the running one.
    const ident = tgz(join(root, "ident.tgz"), { version: "0.1.0", release: "0.1.0+aaa" });
    const r6 = await s.ctx.app.inject({ method: "POST", url: "/api/update/apply", headers: s.asCli, payload: { from: ident, allowDowngrade: true } });
    assert.equal(r6.statusCode, 409);
    assert.match(r6.json().error, /就是正在运行的版本/);
    // A release without the start guard (older builds): never switched to, even with the flag.
    const noGuard = tgz(join(root, "noguard.tgz"), { version: "0.5.0", release: "0.5.0+ddd", guard: false });
    const r7 = await s.ctx.app.inject({ method: "POST", url: "/api/update/apply", headers: s.asCli, payload: { from: noGuard, allowDowngrade: true } });
    assert.equal(r7.statusCode, 409);
    assert.match(r7.json().error, /目标版本不支持安全更新与退回，请手动安装/);
    const c = await s.ctx.app.inject({ method: "DELETE", url: "/api/update/restart", headers: s.asCli });
    assert.equal(c.json().cancelled, true);
    assert.equal(s.ctx.packageUpdate.status().requested, false);
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── pieces ────────────────────────────────────────────────────────────

test("where npm installed it: <prefix>/lib/node_modules/@daisy-ai/daisy (Linux, macOS), <prefix>\\node_modules\\@daisy-ai\\daisy (Windows); a checkout is none", () => {
  assert.equal(globalPrefix("/home/a/.local/lib/node_modules/@daisy-ai/daisy", "linux"), "/home/a/.local");
  assert.equal(globalPrefix("/opt/homebrew/lib/node_modules/@daisy-ai/daisy", "darwin"), "/opt/homebrew");
  assert.equal(globalPrefix("C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@daisy-ai\\daisy", "win32"), "C:\\Users\\a\\AppData\\Roaming\\npm");
  assert.equal(globalPrefix("/home/a/daisy-checkout", "linux"), null);
  assert.equal(globalPrefix("/home/a/proj/node_modules/@daisy-ai/daisy", "linux"), null, "a project-local install is not updated in place");
  // npm without a shell: its CLI script next to node (Windows) or under lib (Linux, macOS).
  const have = (p: string) => /npm-cli\.js$/.test(p) && (p.includes("lib/node_modules/npm") || p.includes("node_modules\\npm") || p.includes("node_modules/npm"));
  assert.deepEqual(npmCommand("/usr/local/bin/node", "linux", have).args.length, 1);
  assert.equal(npmCommand("/usr/local/bin/node", "linux", have).cmd, "/usr/local/bin/node");
  assert.deepEqual(npmCommand("/x/node", "linux", () => false), { cmd: "npm", args: [] });
});

test("versions only move forward (semver; build metadata ignored); a package is read without unpacking it", () => {
  assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0-rc.2", "1.0.0-rc.10") < 0);
  assert.equal(compareVersions("0.1.0+aaa", "0.1.0+bbb"), 0);
  assert.equal(readPackage(tgz(join(tmp(), "g.tgz"), { version: "0.3.0" })).updateGuard, 1);
  assert.equal(readPackage(tgz(join(tmp(), "n.tgz"), { version: "0.3.0", guard: false })).updateGuard, null);
  const root = tmp();
  try {
    const f = tgz(join(root, "a.tgz"), { version: "0.3.0", release: "0.3.0+cafe" });
    assert.deepEqual(readPackage(f), { name: "@daisy-ai/daisy", version: "0.3.0", release: "0.3.0+cafe", updateGuard: 1 });
    assert.equal(readPackage(tgz(join(root, "b.tgz"), { version: "0.3.0", release: null })).release, null);
    writeFileSync(join(root, "c.tgz"), gzipSync(Buffer.alloc(1024)));
    assert.throws(() => readPackage(join(root, "c.tgz")), /没有 package\.json/);
    // No default source (the scope is not registered, the package not published).
    assert.deepEqual(parseSource(undefined), { kind: "none" });
    assert.deepEqual(parseSource(""), { kind: "none" });
    assert.deepEqual(parseSource("npm:@daisy-ai/daisy@latest"), { kind: "npm", spec: "@daisy-ai/daisy@latest" });
    assert.deepEqual(parseSource("off"), { kind: "off" });
    assert.equal(parseSource(join(root, "x.tgz")).kind, "file");
    assert.equal(parseSource(root).kind, "dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory source: the newest Daisy package newer than the running one, copied into update/incoming; nothing newer → none", async () => {
  const root = tmp();
  try {
    const src = join(root, "src");
    mkdirSync(src);
    const data = join(root, "data");
    tgz(join(src, "a.tgz"), { version: "0.1.0", release: "0.1.0+aaa" });
    tgz(join(src, "n.tgz"), { name: "not-daisy", version: "9.0.0" });
    // Newer, but without the start guard: not a candidate.
    tgz(join(src, "z.tgz"), { version: "8.0.0", release: "8.0.0+zzz", guard: false });
    assert.equal(await latestFrom(parseSource(src), { dataDir: data, own: "0.1.0+aaa" }), null, "the same version is not newer");
    tgz(join(src, "c.tgz"), { version: "0.2.1", release: "0.2.1+ccc" });
    tgz(join(src, "b.tgz"), { version: "0.2.0", release: "0.2.0+bbb" });
    const c = await latestFrom(parseSource(src), { dataDir: data, own: "0.1.0+aaa" });
    assert.equal(c!.release, "0.2.1+ccc");
    assert.ok(c!.file.startsWith(join(data, "update", "incoming")));
    assert.ok(existsSync(c!.file));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R-5 backup: a consistent copy of the database before every update, owner-only, newest three kept; none for a fresh data directory", () => {
  const dir = tmp();
  try {
    assert.equal(backupForUpdate(dir, "0.1.0+a", "0.2.0+b"), null);
    const db = new DatabaseSync(join(dir, "daisy.sqlite"));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (42)");
    // Kept open (as the running Daisy keeps it): the copy is still whole.
    const made: string[] = [];
    for (let i = 0; i < 5; i++)
      made.push(backupForUpdate(dir, "0.1.0+a", `0.2.${i}+b`, { now: () => new Date(Date.UTC(2026, 10, 18, 0, 0, i)) })!);
    db.close();
    const copy = new DatabaseSync(made.at(-1)!, { readOnly: true });
    assert.equal((copy.prepare("SELECT x FROM t").get() as any).x, 42);
    copy.close();
    const left = made.filter((p) => existsSync(p));
    assert.deepEqual(left, made.slice(-3));
    if (process.platform !== "win32") for (const p of left) assert.equal((statSync(p).mode & 0o077), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the switch ────────────────────────────────────────────────────────

function updater(root: string, o: Partial<ConstructorParameters<typeof PackageUpdate>[0]> & { calls?: string[]; failInstall?: boolean; failSmoke?: boolean; failBackup?: boolean } = {}) {
  const code = install(root, "0.1.0+aaa");
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const calls = o.calls ?? [];
  let t = 1_000_000;
  const u = new PackageUpdate({
    codeRoot: code,
    dataDir: data,
    own: "0.1.0+aaa",
    auto: false,
    source: "off",
    restartable: () => true,
    backup: (from, to) => {
      calls.push(`backup ${from}→${to}`);
      if (o.failBackup) throw new Error("磁盘满了");
      return join(data, "backups", "b.sqlite");
    },
    audit: (a, d) => calls.push(`audit ${a} ${d}`),
    log: () => {},
    now: () => t,
    requestIdleMs: 5_000,
    idleMs: 60_000,
    steps: {
      keep: async (rel) => {
        calls.push(`keep ${rel}`);
        const p = keptPackage(data, rel);
        mkdirSync(join(data, "update", "packages"), { recursive: true });
        tgz(p, { version: "0.1.0", release: rel });
        return p;
      },
      install: async (_prefix, file) => {
        calls.push(`install ${readPackage(file).release}`);
        if (o.failInstall) throw new Error("npm install 失败：ENOSPC");
        writeFileSync(join(code, ".release"), readPackage(file).release + "\n");
      },
      smoke: async () => {
        calls.push("smoke");
        if (o.failSmoke) throw new Error("新版本加载失败：SyntaxError");
      },
    },
    ...o,
  });
  return { u, code, data, calls, at: (ms: number) => (t = 1_000_000 + ms) };
}

test("the switch, in order: backup → keep the running release's package → install → it loads → pending (from, to, backup, way back); only once idle", async () => {
  const root = tmp();
  try {
    const { u, code, data, calls, at } = updater(root);
    const file = tgz(join(root, "new.tgz"), { version: "0.2.0", release: "0.2.0+bbb" });
    await u.apply({ from: file });
    // Busy: never.
    for (let ms = 0; ms <= 20_000; ms += 1000) {
      at(ms);
      assert.equal(await u.tick(false), null);
    }
    assert.deepEqual(calls.filter((c) => !c.startsWith("audit")), []);
    // Idle, but not long enough; a moment of work resets the clock.
    at(21_000);
    assert.equal(await u.tick(true), null);
    at(24_000);
    assert.equal(await u.tick(false), null);
    at(25_000);
    assert.equal(await u.tick(true), null);
    at(31_000);
    assert.equal(await u.tick(true), "0.2.0+bbb");
    assert.deepEqual(calls.filter((c) => !c.startsWith("audit")), ["backup 0.1.0+aaa→0.2.0+bbb", "keep 0.1.0+aaa", "install 0.2.0+bbb", "smoke"]);
    assert.equal(readFileSync(join(code, ".release"), "utf8").trim(), "0.2.0+bbb");
    const p = readPending(data)!;
    assert.equal(p.from, "0.1.0+aaa");
    assert.equal(p.to, "0.2.0+bbb");
    assert.equal(p.by, "owner");
    assert.equal(p.backup, join(data, "backups", "b.sqlite"));
    assert.equal(p.fromPackage, keptPackage(data, "0.1.0+aaa"));
    assert.equal(p.prefix, join(root, "prefix"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed switch changes nothing: no backup → no install; npm fails → recorded, backed off; it does not load → the running release's package goes back (rolled back, audited)", async () => {
  const root = tmp();
  try {
    let x = updater(join(root, "1"), { failBackup: true });
    await x.u.apply({ from: tgz(join(root, "n1.tgz"), { version: "0.2.0", release: "0.2.0+bbb" }) });
    x.at(0);
    await x.u.tick(true);
    x.at(6000);
    assert.equal(await x.u.tick(true), null);
    assert.deepEqual(x.calls, ["backup 0.1.0+aaa→0.2.0+bbb"]);
    assert.match(readState(x.data).error!, /磁盘满了/);
    assert.equal(readPending(x.data), null);

    x = updater(join(root, "2"), { failInstall: true });
    await x.u.apply({ from: tgz(join(root, "n2.tgz"), { version: "0.2.0", release: "0.2.0+bbb" }) });
    x.at(0);
    await x.u.tick(true);
    x.at(6000);
    assert.equal(await x.u.tick(true), null);
    assert.equal(readFileSync(join(x.code, ".release"), "utf8").trim(), "0.1.0+aaa");
    assert.equal(readState(x.data).history!.at(-1)!.result, "failed");
    assert.ok(readState(x.data).nextAt! > 6000 + 1_000_000, "backed off");
    assert.ok(x.calls.some((c) => c.startsWith("audit update.failed")));

    x = updater(join(root, "3"), { failSmoke: true });
    await x.u.apply({ from: tgz(join(root, "n3.tgz"), { version: "0.2.0", release: "0.2.0+bbb" }) });
    x.at(0);
    await x.u.tick(true);
    x.at(6000);
    assert.equal(await x.u.tick(true), null);
    assert.deepEqual(x.calls.filter((c) => !c.startsWith("audit")), ["backup 0.1.0+aaa→0.2.0+bbb", "keep 0.1.0+aaa", "install 0.2.0+bbb", "smoke", "install 0.1.0+aaa"]);
    assert.equal(readFileSync(join(x.code, ".release"), "utf8").trim(), "0.1.0+aaa", "the running release is back on disk");
    const last = readState(x.data).history!.at(-1)!;
    assert.equal(last.result, "rolled-back");
    assert.match(last.reason!, /加载失败.*已退回 0\.1\.0\+aaa/);
    assert.ok(x.calls.some((c) => c.startsWith("audit update.rolled_back")));
    assert.equal(readPending(x.data), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-update: found in the source and applied after 60 s idle when on; when off, only found — applied once the owner asks; a Daisy that cannot restart never applies", async () => {
  const root = tmp();
  try {
    const src = join(root, "src");
    mkdirSync(src);
    tgz(join(src, "b.tgz"), { version: "0.2.0", release: "0.2.0+bbb" });
    const on = updater(join(root, "on"), { auto: true, source: src, discoverMs: 1000 });
    on.at(0);
    await on.u.tick(true); // looks
    await new Promise((r) => setTimeout(r, 20));
    on.at(30_000);
    assert.equal(await on.u.tick(true), null, "not yet 60 s idle");
    assert.equal(on.u.status().state, "waiting");
    on.at(61_000);
    assert.equal(await on.u.tick(true), "0.2.0+bbb");
    assert.equal(readPending(on.data)!.by, "auto");

    const off = updater(join(root, "off"), { auto: false, source: src });
    off.at(0);
    await off.u.tick(true);
    off.at(100_000);
    assert.equal(await off.u.tick(true), null);
    assert.equal(off.u.status().available, null, "auto off: not even looked for");
    await off.u.check();
    assert.equal(off.u.status().state, "available");
    off.at(200_000);
    assert.equal(await off.u.tick(true), null, "found, not asked");
    off.at(200_500);
    assert.equal(await off.u.tick(false), null, "busy");
    await off.u.apply();
    off.at(201_000);
    assert.equal(await off.u.tick(true), null, "asked: 5 s idle first");
    off.at(207_000);
    assert.equal(await off.u.tick(true), "0.2.0+bbb");

    const fixed = updater(join(root, "fg"), { auto: true, source: src, restartable: () => false });
    await assert.rejects(fixed.u.apply(), /退出后不会自己起来/);
    fixed.at(0);
    await fixed.u.tick(true);
    await new Promise((r) => setTimeout(r, 20));
    fixed.at(1_000_000);
    assert.equal(await fixed.u.tick(true), null);
    assert.equal(fixed.u.ready(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed by hand (npm install -g while running): backed up and put on trial like any update; code that does not load goes back", async () => {
  const root = tmp();
  try {
    const x = updater(root, { failSmoke: true });
    // The way back was kept when 0.1.0+aaa confirmed.
    await x.u.settled();
    writeFileSync(join(x.code, ".release"), "0.2.0+bbb\n");
    assert.equal(await x.u.switchInstalled("0.2.0+bbb"), false);
    assert.equal(readFileSync(join(x.code, ".release"), "utf8").trim(), "0.1.0+aaa");
    assert.equal(readState(x.data).history!.at(-1)!.by, "installed");
    const ok = updater(join(root, "ok"));
    writeFileSync(join(ok.code, ".release"), "0.2.0+bbb\n");
    assert.equal(await ok.u.switchInstalled("0.2.0+bbb"), true);
    assert.equal(readPending(ok.data)!.to, "0.2.0+bbb");
    assert.equal(readPending(ok.data)!.by, "installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the start guard ───────────────────────────────────────────────────

const pend = (o: Partial<Pending> = {}): Pending => ({
  id: "u1",
  from: "0.1.0+aaa",
  to: "0.2.0+bbb",
  fromPackage: "/d/update/packages/0.1.0+aaa.tgz",
  toPackage: null,
  prefix: "/p",
  backup: "/d/backups/x.sqlite",
  at: 1,
  by: "auto",
  starts: 0,
  ...o,
});

test("guard decisions: the new release is on trial; failed or MAX_STARTS starts → roll back; the previous release back → done; a third release → over", () => {
  assert.equal(decideGuard(null, "x").kind, "none");
  assert.equal(decideGuard(pend(), "0.2.0+bbb").kind, "trial");
  assert.equal(decideGuard(pend({ starts: MAX_STARTS - 1 }), "0.2.0+bbb").kind, "trial");
  assert.equal(decideGuard(pend({ starts: MAX_STARTS }), "0.2.0+bbb").kind, "rollback");
  assert.equal(decideGuard(pend({ failed: "x" }), "0.2.0+bbb").kind, "rollback");
  assert.equal(decideGuard(pend({ failed: "x", fromPackage: null }), "0.2.0+bbb").kind, "stuck");
  assert.equal(decideGuard(pend({ failed: "x", rolledBack: { at: 1, ok: false, error: "e" } }), "0.2.0+bbb").kind, "stuck");
  assert.equal(decideGuard(pend({ rolledBack: { at: 1, ok: true } }), "0.1.0+aaa").kind, "back");
  assert.equal(decideGuard(pend(), "0.3.0+ccc").kind, "stale");
  assert.equal(comeback({ DAISY_RESPAWN: "1" }), "respawn");
  assert.equal(comeback({ INVOCATION_ID: "x" }), "manager");
  assert.equal(comeback({ DAISY_LAUNCHD_LABEL: "ai.daisy.daisy" }), "manager");
  assert.equal(comeback({}), "none");
});

function guardRig(own: string, env: Record<string, string> = { DAISY_RESPAWN: "1" }) {
  const data = tmp();
  const seen: string[] = [];
  const g = new StartGuard({
    dataDir: data,
    own,
    env: env as NodeJS.ProcessEnv,
    confirmMs: 60_000,
    log: () => {},
    install: (prefix, tgz) => {
      seen.push(`install ${prefix} ${tgz}`);
      return { ok: true };
    },
    exit: (code) => {
      seen.push(`exit ${code}`);
    },
    successor: () => {
      seen.push("successor");
    },
  });
  return { g, data, seen };
}

test("trial confirmed: counted, then recorded `updated` with its backup; the record goes", () => {
  const { g, data, seen } = guardRig("0.2.0+bbb");
  try {
    writePending(data, pend());
    assert.equal(g.begin(), true);
    assert.equal(g.trial, true);
    assert.equal(readPending(data)!.starts, 1);
    assert.equal(g.confirm(), true);
    assert.equal(readPending(data), null);
    const h = readState(data).history!.at(-1)!;
    assert.deepEqual([h.result, h.from, h.to, h.backup], ["updated", "0.1.0+aaa", "0.2.0+bbb", "/d/backups/x.sqlite"]);
    assert.deepEqual(seen, []);
    assert.equal(g.confirm(), false, "once");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("trial failed: an exit before healthy rolls back (npm install of the previous package) and starts the successor; the owner's stop (0) does not; the previous release records it", () => {
  let r = guardRig("0.2.0+bbb");
  try {
    writePending(r.data, pend());
    r.g.begin();
    (r.g as any).exited(1);
    assert.deepEqual(r.seen, ["install /p /d/update/packages/0.1.0+aaa.tgz", "successor"]);
    const p = readPending(r.data)!;
    assert.match(p.failed!, /退出码 1/);
    assert.equal(p.rolledBack!.ok, true);
    // The previous release starts: the outcome is recorded, the record goes.
    const back = guardRig("0.1.0+aaa");
    writePending(back.data, p);
    assert.equal(back.g.begin(), true);
    assert.equal(readPending(back.data), null);
    const h = readState(back.data).history!.at(-1)!;
    assert.equal(h.result, "rolled-back");
    assert.match(h.reason!, /退出码 1/);
    rmSync(back.data, { recursive: true, force: true });
  } finally {
    rmSync(r.data, { recursive: true, force: true });
  }
  r = guardRig("0.2.0+bbb");
  try {
    writePending(r.data, pend());
    r.g.begin();
    (r.g as any).exited(0);
    (r.g as any).exited(75);
    assert.deepEqual(r.seen, [], "a stop or a restart is not a failure");
    assert.equal(readPending(r.data)!.starts, 1);
  } finally {
    rmSync(r.data, { recursive: true, force: true });
  }
});

test("MAX_STARTS starts without becoming healthy (a crash the exit handler never saw): rolled back at the next start, then exit 75 for the service manager", () => {
  const r = guardRig("0.2.0+bbb", { INVOCATION_ID: "x" });
  try {
    writePending(r.data, pend({ starts: MAX_STARTS }));
    assert.equal(r.g.begin(), false);
    assert.deepEqual(r.seen, ["install /p /d/update/packages/0.1.0+aaa.tgz", "exit 75"]);
    assert.match(readPending(r.data)!.failed!, new RegExp(`启动了 ${MAX_STARTS} 次`));
  } finally {
    rmSync(r.data, { recursive: true, force: true });
  }
});

test("a release that cannot even load (main.ts's import of the rest failed) is given up at its exit", () => {
  const r = guardRig("0.2.0+bbb");
  try {
    writePending(r.data, pend());
    r.g.begin();
    r.g.loadFailed(new SyntaxError("Unexpected token"));
    (r.g as any).exited(1);
    assert.match(readPending(r.data)!.failed!, /加载失败：Unexpected token/);
    assert.equal(r.seen[0], "install /p /d/update/packages/0.1.0+aaa.tgz");
  } finally {
    rmSync(r.data, { recursive: true, force: true });
  }
});

// ── restarting without a service manager ──────────────────────────────

test("`daisy start`'s background process restarts itself (respawn); turned off, under launchd or systemd it is theirs; --foreground is not supervised", () => {
  assert.deepEqual(supervision({ env: { DAISY_RESPAWN: "1" }, platform: "win32", parentName: () => "x" }), {
    supervised: true,
    manager: "respawn",
    platform: "win32",
  });
  assert.equal(supervision({ env: { DAISY_RESPAWN: "1", DAISY_RUNNER_SELF_RESTART: "0" }, platform: "linux" }).supervised, false);
  assert.equal(supervision({ env: { DAISY_RESPAWN: "1", DAISY_LAUNCHD_LABEL: "ai.daisy.daisy" }, ppid: 1, platform: "darwin" }).manager, "launchd");
  assert.equal(supervision({ env: {}, platform: "linux", parentName: () => "zsh" }).supervised, false);
});

// ── uninstall: one interface, one implementation per system ───────────

test("I-3 uninstall hooks: Linux systemd, macOS launchd, Windows the HKCU Run entry (P5-05); uninstall says how to delete the data in that system's shell", async () => {
  assert.equal(autostartHooks("linux")!.implemented, true);
  assert.equal(autostartHooks("darwin")!.implemented, true);
  assert.equal(autostartHooks("win32"), windowsHooks);
  // P5-05 (ADR-141): the Run entry — through the helper ("daisy-win"), here a test's io that has none.
  assert.equal(windowsHooks.implemented, true);
  assert.equal(await windowsHooks.remove({ io: testIo({ platform: "win32" }), dataDir: "x" }), false);
  assert.deepEqual(await windowsHooks.leftovers({ io: testIo({ platform: "win32" }), dataDir: "x" }), []);
  assert.match(windowsHooks.manualRemoval({ io: testIo({ platform: "win32" }), dataDir: "x" }), /Remove-ItemProperty .*CurrentVersion\\Run" -Name "Daisy-[0-9a-f]{8}"/);
  assert.equal(supervisorName('"C:\\h\\daisy-win.exe" supervise --name Daisy-0123abcd --log "C:\\l"'), "Daisy-0123abcd");
  const root = tmp();
  try {
    const dir = join(root, "data");
    mkdirSync(dir);
    const r = await daisy(testIo({ platform: "win32" }), dir, "uninstall", "--yes");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /✓ 没有开机自启项/);
    assert.ok(r.out.includes(`数据目录保留在：${dir}`));
    assert.match(r.out, /Remove-Item -Recurse -Force/);
    assert.match(r.out, /npm uninstall -g @daisy-ai\/daisy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the update source: no default; setting it takes the PIN ───────────

test("P5N-2: right after `update --source` the node's auto-update (catalog, daisy status) says the new source — not the Runner's last sync", async () => {
  const s = await issuerDaisy();
  const root = tmp();
  try {
    const code = install(root, "0.1.0+aaa");
    s.ctx.packageUpdate = new PackageUpdate({ codeRoot: code, dataDir: s.dir, own: "0.1.0+aaa", auto: true, restartable: () => true, backup: () => null, log: () => {} });
    // What the Runner reported at its last sync, before the source was set.
    const stale = { runner: { release: "0.1.0+aaa", autoUpdate: nodeAutoUpdate(s.ctx.packageUpdate.status()) } };
    assert.equal(stale.runner.autoUpdate.state, "no-source");
    s.ctx.store.run("UPDATE nodes SET capabilities=?, last_seen=?", JSON.stringify(stale), Date.now());
    const put = await s.ctx.app.inject({ method: "PUT", url: "/api/update/source", headers: s.withPin(), payload: { source: root } });
    assert.equal(put.statusCode, 200, put.body);
    const cat = (await s.ctx.app.inject({ url: "/api/catalog", headers: s.asCli })).json();
    const au = cat.nodes.map((n: any) => n.capabilities?.runner?.autoUpdate).find(Boolean);
    assert.notEqual(au.state, "no-source");
    assert.equal(au.source, s.ctx.packageUpdate.status().source);
    assert.equal(cat.nodes[0].capabilities.runner.release, "0.1.0+aaa", "the rest of the report as it was");
    // `daisy status` reads the updater's own answer first (GET /api/update's package).
    const st = (await s.ctx.app.inject({ url: "/api/update", headers: s.asCli })).json();
    assert.equal(nodeAutoUpdate(st.package).state, au.state);
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("refused first: setting the update source — the AI's credential never, the owner without the PIN never; nothing written", async () => {
  const s = await issuerDaisy();
  const root = tmp();
  try {
    const t = await runningTurn(s);
    const code = install(root, "0.1.0+aaa");
    s.ctx.packageUpdate = new PackageUpdate({ codeRoot: code, dataDir: s.dir, own: "0.1.0+aaa", auto: true, restartable: () => true, backup: () => null, log: () => {} });
    const put = (headers: Record<string, string>, source: unknown = root) =>
      s.ctx.app.inject({ method: "PUT", url: "/api/update/source", headers, payload: { source } });
    const ai = await put({ authorization: `Bearer ${t.ai}` });
    assert.ok([401, 403].includes(ai.statusCode), `AI: ${ai.statusCode}`);
    const noPin = await put(s.asCli);
    assert.equal(noPin.statusCode, 403);
    assert.equal(noPin.json().code, "pin_required");
    const web = await put({ authorization: `Bearer ${s.ctx.issueToken()}` });
    assert.equal(web.json().code, "pin_required", "the web page too (D-40 ①: writes take the PIN)");
    assert.equal(JSON.parse(readFileSync(join(s.dir, "runner.json"), "utf8")).updateSource, undefined, "nothing written");
    assert.equal(s.ctx.packageUpdate.status().sourceSet, false);
    // With the PIN: only this package on npm, only a directory / .tgz that exists, absolute.
    for (const bad of ["npm:left-pad@latest", "npm:@daisy-ai/daisy-evil", "relative/dir", join(root, "missing")]) {
      const r = await put(s.withPin(), bad);
      assert.equal(r.statusCode, 400, bad);
      assert.equal(r.json().code, "invalid_source");
    }
    const ok = await put(s.withPin());
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().package.sourceSet, true);
    assert.equal(JSON.parse(readFileSync(join(s.dir, "runner.json"), "utf8")).updateSource, root);
    const npm = await put(s.withPin(), "npm:@daisy-ai/daisy@latest");
    assert.equal(npm.statusCode, 200, npm.body);
    const cleared = await put(s.withPin(), null);
    assert.equal(cleared.json().package.sourceSet, false);
    assert.equal(JSON.parse(readFileSync(join(s.dir, "runner.json"), "utf8")).updateSource, undefined);
    const audit = s.ctx.store.all("SELECT target FROM audit WHERE action='update.source'") as any[];
    assert.equal(audit.length, 3);
  } finally {
    await s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("no source (the default): auto-update on but quiet — nothing looked at, no error; check and apply without a package say so; --from still works", async () => {
  const root = tmp();
  try {
    let looked = 0;
    const x = updater(root, { auto: true, source: undefined, discoverMs: 1, steps: undefined });
    (x.u as any).o.steps = { ...(x.u as any).o.steps, latest: async () => (looked++, null) };
    for (let ms = 0; ms < 10_000; ms += 1000) {
      x.at(ms);
      assert.equal(await x.u.tick(true), null);
    }
    assert.equal(looked, 0, "never looked");
    const st = x.u.status();
    assert.equal(st.state, "no-source");
    assert.equal(st.sourceSet, false);
    assert.equal(st.auto, true, "D-34: still on in the configuration");
    assert.equal(st.error, undefined, "no E404 noise");
    await assert.rejects(x.u.check(), /没有设置更新来源/);
    await assert.rejects(x.u.apply(), /没有设置更新来源/);
    const s2 = await x.u.apply({ from: tgz(join(root, "n.tgz"), { version: "0.2.0", release: "0.2.0+bbb" }) });
    assert.equal(s2.state, "waiting");
    // The command line, Daisy not running: --check says so and fails.
    const dir = join(root, "cli-data");
    mkdirSync(dir);
    const r = await daisy(testIo({ env: { DAISY_UPDATE_SOURCE: "" } }), dir, "update", "--check");
    assert.notEqual(r.code, 0);
    assert.match(r.err + r.out, /没有设置更新来源/);
    // Setting it needs the PIN, so a running Daisy.
    const r2 = await daisy(testIo(), dir, "update", "--source", root);
    assert.notEqual(r2.code, 0);
    assert.match(r2.err + r2.out, /要 PIN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the uninstall command printed is this install's: npm uninstall -g --prefix <its prefix>, quoted for this system's shell", () => {
  assert.equal(uninstallCommand("/home/a/.local/lib/node_modules/@daisy-ai/daisy", "linux"), "npm uninstall -g --prefix /home/a/.local @daisy-ai/daisy");
  assert.equal(uninstallCommand("/Users/a/My Tools/lib/node_modules/@daisy-ai/daisy", "darwin"), "npm uninstall -g --prefix '/Users/a/My Tools' @daisy-ai/daisy");
  assert.equal(uninstallCommand("/x/it's/lib/node_modules/@daisy-ai/daisy", "linux"), "npm uninstall -g --prefix '/x/it'\\''s' @daisy-ai/daisy");
  assert.equal(
    uninstallCommand("C:\\Users\\a b\\AppData\\Roaming\\npm\\node_modules\\@daisy-ai\\daisy", "win32"),
    'npm uninstall -g --prefix "C:\\Users\\a b\\AppData\\Roaming\\npm" @daisy-ai/daisy',
  );
  // Not an npm global install (a checkout): the plain command, nothing to guess.
  assert.equal(uninstallCommand("/home/a/daisy-checkout", "linux"), "npm uninstall -g @daisy-ai/daisy");
});

test("P6-01 (ADR-151): the node's auto-update line is the npm update's only (the git-checkout updater is gone); the auto-update switch shows", () => {
  const base: PackageStatus = {
    supported: true, auto: true, source: "npm:@daisy-ai/daisy@latest", sourceSet: true, restartable: true,
    running: "1.0.0+abc", installed: "1.0.0+abc", available: null, requested: false, state: "current",
    checkedAt: 1, last: null, pending: null,
  };
  // No updater at all (a Runner run without one) and a Daisy not installed by npm: why not, never a git checkout's story.
  const none = nodeAutoUpdate(undefined);
  assert.equal(none.state, "unsupported");
  assert.doesNotMatch(String(none.reason), /launch\.sh|启动器|GitHub|git/i);
  const checkout = nodeAutoUpdate({ ...base, supported: false, reason: "不是用 npm 全局安装的（代码检出或别的方式）：更新请在原处手动做", state: "unsupported" });
  assert.deepEqual([checkout.state, checkout.reason], ["unsupported", "不是用 npm 全局安装的（代码检出或别的方式）：更新请在原处手动做"]);
  // On (the default) and up to date / a newer one waiting or going in.
  assert.equal(nodeAutoUpdate(base).state, "current");
  assert.deepEqual(nodeAutoUpdate({ ...base, state: "waiting", available: { version: "1.1.0", release: "1.1.0+def" } }), { state: "pending", mode: "package", auto: true, target: "1.1.0+def", source: base.source });
  assert.equal(nodeAutoUpdate({ ...base, state: "updating" }).state, "pending");
  // runner.json autoUpdate: false (D-34's switch): "disabled", and a newer one only "available" (the owner applies it).
  assert.equal(nodeAutoUpdate({ ...base, auto: false }).state, "disabled");
  const avail = nodeAutoUpdate({ ...base, auto: false, state: "available", available: { version: "1.1.0", release: null } });
  assert.deepEqual([avail.state, avail.target], ["available", "1.1.0"]);
  // No source, a failure: as they are.
  assert.equal(nodeAutoUpdate({ ...base, state: "no-source", sourceSet: false }).state, "no-source");
  const failed = nodeAutoUpdate({ ...base, state: "failed", error: "npm 失败", nextAt: 5 });
  assert.deepEqual([failed.state, failed.error, failed.nextAt], ["failed", "npm 失败", 5]);
  // The settings page words each of them, none about the old updater's states.
  assert.match(autoUpdateLine({ state: "disabled" }).text, /自动更新已关闭/);
  assert.doesNotMatch(autoUpdateLine({ state: "disabled" }).text, /直到升级前备份上线/);
  assert.match(autoUpdateLine({ state: "available", target: "1.1.0" }).text, /1\.1\.0.*daisy update --apply/);
  assert.match(autoUpdateLine({ state: "no-source" }).text, /更新来源/);
  assert.equal(autoUpdateLine({ state: "pending", target: "1.1.0+def" }).text.includes("1.1.0+def"), true);
});
