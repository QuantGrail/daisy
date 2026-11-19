/**
 * P5-06 (ADR-145), acceptance R-5 「升级到新版本：升级前有备份；升级后旧数
 * 据都在；失败时能退回」 and I-3 for an npm install — the real thing:
 *
 * three releases packed from this checkout (scripts/pack-daisy.ts, never
 * published): A (older), B (newer) and C (newer still, but broken: its
 * process cannot load). A is installed with `npm install -g --prefix
 * <temp>` (offline, from npm's cache: no network), started with its own
 * `daisy start` (a background process, no service manager) on a temporary
 * data directory, and given data (a session).
 *
 *   1. auto-update (D-34: on by default): B dropped into the update source
 *      — found, backed up, installed, restarted into, confirmed healthy;
 *      the session is still there, the backup holds it, the audit says so.
 *   2. forced failure: `daisy update --apply --from C` — installed, it
 *      cannot start, the guard puts B back and B runs again; recorded as
 *      rolled back with why; the data is untouched.
 *   3. `daisy update --rollback` while Daisy is stopped — A goes back in;
 *      the next `daisy start` backs the database up first, then confirms.
 *   4. `daisy uninstall` — no Daisy process left, the data directory kept
 *      and named.
 *
 * Never the owner's Daisy, data or ~/.local: everything under one
 * temporary directory. Skipped where npm's cache lacks a dependency
 * (offline install impossible) — said, not hidden.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stage } from "../scripts/pack-daisy.ts";
import { npmCommand } from "../packages/daisy/src/update/package.ts";

const SKIP =
  process.platform === "win32"
    ? "Windows：daisy stop 在 Windows 上是强制结束（P5-05），这条要在 Windows CI 上随 P5-05 一起跑"
    : false;

const npm = npmCommand();
function npmRun(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(npm.cmd, [...npm.args, ...args], { encoding: "utf8", env, timeout: 600_000 });
}

/** Pack this checkout as `version` / `release`; `broken`: its process cannot load. */
function packRelease(root: string, version: string, release: string, o: { broken?: boolean } = {}): string {
  const dir = join(root, `stage-${version}`);
  mkdirSync(dir, { recursive: true });
  stage(dir, { web: false });
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkg.version = version;
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(join(dir, ".release"), release + "\n");
  if (o.broken) {
    const daemon = join(dir, "packages/daisy/src/daemon.ts");
    writeFileSync(daemon, `throw new Error("P5-06 测试：这个版本故意坏掉");\n` + readFileSync(daemon, "utf8"));
  }
  const out = join(root, "out", version);
  mkdirSync(out, { recursive: true });
  const r = npmRun(["pack", dir, "--pack-destination", out, "--silent"], process.env);
  assert.equal(r.status, 0, r.stderr);
  rmSync(dir, { recursive: true, force: true });
  return join(out, readdirSync(out).find((f) => f.endsWith(".tgz"))!);
}

test("R-5 / I-3: npm-installed Daisy — auto-update keeps the data and backs it up; a broken release is rolled back; --rollback while stopped; uninstall leaves no process", { skip: SKIP, timeout: 600_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "daisy-r5-"));
  const prefix = join(root, "prefix");
  const data = join(root, "data");
  const source = join(root, "source");
  mkdirSync(source);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DAISY_DATA: data,
    // Offline: dependencies from npm's cache, never the network.
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    DAISY_UPDATE_SOURCE: source,
  };
  delete env.DAISY_LOCAL_RUNNER;
  delete env.DAISY_RESPAWN;
  delete env.DAISY_RESPAWN_AFTER;
  const code = join(prefix, process.platform === "win32" ? "" : "lib", "node_modules", "@daisy-ai", "daisy");
  const bin = join(code, "packages/daisy/bin/daisy.mjs");
  const daisy = (...args: string[]) => {
    const r = spawnSync(process.execPath, [bin, ...args], { env, encoding: "utf8", cwd: root, timeout: 300_000 });
    return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  const status = () => {
    const r = daisy("status", "--json");
    try {
      return JSON.parse(r.out.slice(r.out.indexOf("{")));
    } catch {
      return { running: false, raw: r.out };
    }
  };
  const until = async (what: string, ok: () => boolean, ms = 180_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (ok()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    let log = "";
    try {
      log = readFileSync(join(data, "logs", "daisy.log"), "utf8").split("\n").slice(-40).join("\n");
    } catch {}
    assert.fail(`等不到：${what}\n日志最后几行：\n${log}`);
  };
  const api = async (path: string, init: RequestInit = {}) => {
    const rt = JSON.parse(readFileSync(join(data, "runtime.json"), "utf8"));
    const cred = readFileSync(join(data, "keys", "cli-credential"), "utf8").trim();
    const r = await fetch(rt.local.url + path, { ...init, headers: { authorization: `Bearer ${cred}`, "content-type": "application/json", ...(init.headers ?? {}) } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const audit = () => {
    const db = new DatabaseSync(join(data, "daisy.sqlite"), { readOnly: true });
    try {
      return (db.prepare("SELECT action, target FROM audit WHERE action LIKE 'update.%' ORDER BY created").all() as any[]).map((r) => `${r.action} ${r.target}`);
    } finally {
      db.close();
    }
  };
  try {
    const A = packRelease(root, "0.0.1", "0.0.1+r5aaaaaaaaaa");
    const B = packRelease(root, "0.0.2", "0.0.2+r5bbbbbbbbbb");
    const C = packRelease(root, "0.0.3", "0.0.3+r5cccccccccc", { broken: true });
    const inst = npmRun(["install", "-g", "--prefix", prefix, A], env);
    if (inst.status !== 0 && /ENOTCACHED|cache mode is 'only-if-cached'/.test(inst.stderr)) {
      t.skip(`npm 的缓存里缺依赖，离线装不了（不走网络）：${inst.stderr.split("\n").find((l) => /ENOTCACHED|only-if-cached/.test(l))}`);
      return;
    }
    assert.equal(inst.status, 0, inst.stderr);

    // First start writes runner.json; shorten the waits for the test, start again.
    let r = daisy("start");
    assert.equal(r.code, 0, r.out);
    assert.equal(daisy("stop").code, 0);
    const rj = join(data, "runner.json");
    writeFileSync(rj, JSON.stringify({ ...JSON.parse(readFileSync(rj, "utf8")), restartIdleMs: 2000, restartRequestIdleMs: 1000, updateDiscoverMs: 1000 }, null, 2));
    r = daisy("start");
    assert.equal(r.code, 0, r.out);
    assert.equal(status().release, "0.0.1+r5aaaaaaaaaa");
    // I-1's automatic part: one command installed it, it started, the web page opens by command.
    r = daisy("open", "--print");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /http:\/\/127\.0\.0\.1:\d+\/\S*/);
    // A's own package is kept once it is up (the way back for the next update).
    await until("A 的包留作退路", () => existsSync(join(data, "update", "packages", "0.0.1_r5aaaaaaaaaa.tgz")));
    // Data: a session.
    const cat = (await api("/api/catalog")).json;
    const made = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ agent: "claude", workspaceId: cat.workspaces[0].id, profileId: cat.profiles.find((p: any) => p.agent === "claude").id, title: "R-5 的旧数据" }),
    });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const sid = made.json.id;

    // ── 1. auto-update to B ──────────────────────────────────────────
    cpSync(B, join(source, "daisy-ai-daisy-0.0.2.tgz"));
    await until("自动更新换上 B 并确认", () => {
      const s = status();
      return s.running && s.release === "0.0.2+r5bbbbbbbbbb" && s.lastUpdate?.result === "updated";
    });
    let s = status();
    assert.equal(s.lastUpdate.from, "0.0.1+r5aaaaaaaaaa");
    assert.equal(s.lastUpdate.by, "auto");
    assert.equal(s.updatePending, null);
    // The backup was taken before, and holds the old data.
    assert.ok(s.lastUpdate.backup && existsSync(s.lastUpdate.backup), "更新前有备份");
    const copy = new DatabaseSync(s.lastUpdate.backup, { readOnly: true });
    assert.equal(JSON.parse((copy.prepare("SELECT data FROM sessions WHERE id=?").get(sid) as any)?.data ?? "{}").title, "R-5 的旧数据");
    copy.close();
    // The old data is all there, through the new release.
    const shown = (await api(`/api/sessions/${sid}`)).json;
    assert.equal(shown?.session?.title ?? shown?.title, "R-5 的旧数据");
    await until("审计记下这次更新", () => audit().some((a) => a.startsWith("update.applied") && a.includes("0.0.2+r5bbbbbbbbbb")));
    assert.match(daisy("status").out, /上次更新\s+0\.0\.1\+r5aaaaaaaaaa → 0\.0\.2\+r5bbbbbbbbbb 已换上/);
    await until("B 的包留作退路", () => existsSync(join(data, "update", "packages", "0.0.2_r5bbbbbbbbbb.tgz")));

    // ── 2. a broken release C: installed, cannot start, B goes back ───
    r = daisy("update", "--apply", "--from", C);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /换上 0\.0\.3\+r5cccccccccc/);
    await until("C 失败、退回 B", () => {
      const x = status();
      return x.running && x.release === "0.0.2+r5bbbbbbbbbb" && x.lastUpdate?.result === "rolled-back";
    });
    s = status();
    assert.equal(s.lastUpdate.to, "0.0.2+r5bbbbbbbbbb", "back to B");
    assert.equal(s.lastUpdate.from, "0.0.3+r5cccccccccc");
    assert.match(s.lastUpdate.reason, /故意坏掉|加载失败|退出码/);
    assert.equal(readFileSync(join(code, ".release"), "utf8").trim(), "0.0.2+r5bbbbbbbbbb", "B is on disk again");
    assert.equal((await api(`/api/sessions/${sid}`)).status, 200, "the data is untouched");
    await until("审计记下这次退回", () => audit().some((a) => a.startsWith("update.rolled_back") && a.includes("0.0.3+r5cccccccccc")));
    assert.match(daisy("status").out, /失败，已退回/);

    // ── 3. --rollback while stopped: A again, backed up at its start ──
    assert.equal(daisy("stop").code, 0);
    r = daisy("update", "--rollback");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /已装好 0\.0\.1\+r5aaaaaaaaaa/);
    assert.equal(readFileSync(join(code, ".release"), "utf8").trim(), "0.0.1+r5aaaaaaaaaa");
    const before = readdirSync(join(data, "backups")).filter((f) => f.startsWith("daisy-update-")).length;
    r = daisy("start");
    assert.equal(r.code, 0, r.out);
    await until("A 启动并确认", () => {
      const x = status();
      return x.running && x.release === "0.0.1+r5aaaaaaaaaa" && x.lastUpdate?.result === "updated" && x.lastUpdate?.to === "0.0.1+r5aaaaaaaaaa";
    });
    s = status();
    assert.ok(s.lastUpdate.backup && existsSync(s.lastUpdate.backup), "backed up at start, before A opened the database");
    assert.equal(readdirSync(join(data, "backups")).filter((f) => f.startsWith("daisy-update-")).length, before + 1);
    assert.equal((await api(`/api/sessions/${sid}`)).status, 200);

    // ── 4. uninstall: no process, no autostart item, data kept ─────────
    const pid = JSON.parse(readFileSync(join(data, "runtime.json"), "utf8")).pid;
    r = daisy("uninstall", "--yes");
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes(`数据目录保留在：${data}`));
    // The command printed removes THIS install (its own prefix), not another one.
    // (macOS: the temporary directory is /var → /private/var; the command names the real path.)
    assert.ok(r.out.includes(`npm uninstall -g --prefix ${realpathSync(prefix)} @daisy-ai/daisy`), r.out);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "no Daisy process left");
    const ps = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout ?? "";
    assert.ok(!ps.split("\n").some((l) => l.includes(prefix) && l.includes("main.ts")), "nothing of this install still runs");
    assert.ok(existsSync(join(data, "daisy.sqlite")), "the data directory stays");
    // The command itself goes with npm — the same command on every system.
    const un = npmRun(["uninstall", "-g", "--prefix", prefix, "@daisy-ai/daisy"], env);
    assert.equal(un.status, 0, un.stderr);
    assert.equal(existsSync(code), false);
  } finally {
    // Whatever happened: no Daisy of this test keeps running.
    try {
      const pid = JSON.parse(readFileSync(join(data, "runtime.json"), "utf8")).pid;
      process.kill(pid, "SIGTERM");
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
