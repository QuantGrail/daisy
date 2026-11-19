import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  readFileSync,
  statSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { join, resolve, parse } from "node:path";
import { tmpdir } from "node:os";
import {
  browseDirectory,
  ensureDirectory,
} from "../packages/daisy/src/turns/filesystem.ts";
import { createApp } from "../packages/daisy/src/app.ts";
import { runNode } from "../packages/daisy/src/turns/worker.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import { safeWorkspace } from "../packages/daisy/src/harness/shared.ts";
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";
test(
  "filesystem-wide selection retains home default and obeys Linux directory permissions",
  {
    skip: process.platform !== "linux" || process.getuid?.() === 0,
  },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "daisy-os-permissions-"));
    const home = join(dir, "home"),
      other = join(dir, "other"),
      denied = join(dir, "denied"),
      readonly = join(dir, "readonly");
    for (const path of [home, other, denied, readonly]) mkdirSync(path);
    const config: any = {
      allowedRoots: [parse(dir).root],
      workspaceHome: home,
    };
    try {
      assert.equal(browseDirectory(config, "~").path, home);
      assert.equal(browseDirectory(config, "~").parent, dir);
      assert.equal(browseDirectory(config, other).path, other);
      assert.equal(
        ensureDirectory(config, join(other, "created")).created,
        true,
      );
      assert.equal(safeWorkspace(other, config.allowedRoots), other);
      chmodSync(denied, 0o000);
      chmodSync(readonly, 0o500);
      const permissionError = (e: any) => e.code === "EACCES";
      assert.throws(() => browseDirectory(config, denied), permissionError);
      assert.throws(() => ensureDirectory(config, denied), permissionError);
      assert.throws(
        () => safeWorkspace(denied, config.allowedRoots),
        permissionError,
      );
      assert.equal(ensureDirectory(config, readonly).path, readonly);
      assert.throws(
        () => ensureDirectory(config, join(readonly, "new")),
        permissionError,
      );
      assert.equal(statSync(readonly).mode & 0o777, 0o500);
    } finally {
      chmodSync(denied, 0o700);
      chmodSync(readonly, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test("folder browsing and creation respect canonical roots, hidden entries and existing files", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "daisy-paths-"))),
    home = join(dir, "home"),
    outside = join(dir, "outside");
  mkdirSync(home);
  mkdirSync(outside);
  const config: any = { allowedRoots: [home], workspaceHome: home };
  try {
    mkdirSync(join(home, "project"));
    mkdirSync(join(home, ".hidden"));
    writeFileSync(join(home, "file.txt"), "preserve");
    symlinkSync(outside, join(home, "escape"));
    symlinkSync(join(home, "project"), join(home, "alias"));
    const listing = browseDirectory(config, "~");
    assert.equal(listing.home, home);
    assert.equal(listing.parent, null);
    assert.deepEqual(
      listing.entries.map((x) => x.name),
      ["alias", "project"],
    );
    assert.ok(
      browseDirectory(config, "", 0, true).entries.some(
        (x) => x.name === ".hidden",
      ),
    );
    const made = ensureDirectory(config, "~/new folder/项目");
    assert.equal(made.path, join(home, "new folder", "项目"));
    assert.equal(made.created, true);
    assert.equal(ensureDirectory(config, made.path).created, false);
    assert.throws(
      () => ensureDirectory(config, join(home, "file.txt")),
      /不是文件夹/,
    );
    assert.equal(readFileSync(join(home, "file.txt"), "utf8"), "preserve");
    assert.throws(() => ensureDirectory(config, "../outside/new"), /允许访问/);
    assert.throws(() => ensureDirectory(config, "~/escape/new"), /允许访问/);
    assert.throws(() => browseDirectory(config, "~/escape"), /允许访问/);
    assert.throws(() => ensureDirectory(config, "hello\nworld"), /无效字符/);
    assert.equal(
      ensureDirectory(config, "~/alias").path,
      join(home, "project"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test(
  "remote folder requests authorize owners, create on runner, deduplicate and set the Agent cwd",
  { timeout: 30000 },
  async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "daisy-fs-integration-"))),
      home = join(dir, "node-home");
    mkdirSync(home);
    const { app, store, issueToken, runnerApi } = await createApp({ pinGate: false,
      dataDir: join(dir, "data"),
      workspaceHome: home,
    });
  const inject = runnerInject(app, runnerApi);
    const url = await app.listen({ host: "127.0.0.1", port: 0 }),
      client = new DaisyClient(url, issueToken());
    const config = JSON.parse(
      readFileSync(join(dir, "data", "runner.json"), "utf8"),
    );
    assert.deepEqual(config.allowedRoots, [parse(home).root]);
    config.api = runnerApi(config.nodeId);
    for (const a of ["CLAUDE", "CODEX", "KIMI"])
      process.env[`DAISY_${a}_BIN`] = resolve("tests/fixtures/agent.cjs");
    // Runner state (result journal, restart requests) under the test dir.
    config.identityRoot ??= join(dir, "runner-state-root");
    const abort = new AbortController(),
      worker = runNode(config, abort.signal);
    try {
      for (
        let n = 0;
        n < 50 && !store.one("SELECT last_seen FROM nodes").last_seen;
        n++
      )
        await new Promise((r) => setTimeout(r, 100));
      const listing = await client.browseDirectories(config.nodeId);
      assert.equal(listing.home, home);
      const workspace = await client.ensureWorkspace(
        config.nodeId,
        "~/new-project",
      );
      assert.ok(statSync(workspace.path).isDirectory());
      assert.equal(
        (await client.ensureWorkspace(config.nodeId, workspace.path)).id,
        workspace.id,
      );
      // P1-03: no other members — who may browse is the guard's
      // (tests/access-*.test.ts).
      const queued = await client.request(
        `/nodes/${config.nodeId}/filesystem`,
        "POST",
        { operation: "browse", path: "~" },
      );
      const unauthorized = await inject({
        url: `/api/runner/filesystem/${queued.id}/complete`,
        method: "POST",
        headers: { ...runnerHeaders(config.nodeId), "x-lease": "wrong" },
        payload: { directory: { path: home, created: false } },
      });
      assert.equal(unauthorized.statusCode, 409);
      const catalog = await client.catalog(),
        profile = catalog.profiles.find((p) => p.agent === "codex")!;
      const session = await client.create({
        agent: "codex",
        title: "cwd verification",
        profileId: profile.id,
        workspaceId: workspace.id,
      });
      await client.send(session.id, "WAIT_UNTIL_CANCEL");
      let snapshot: any;
      for (let i = 0; i < 100; i++) {
        snapshot = await client.snapshot(session.id);
        if (snapshot.items.some((x: any) => x.name === "执行节点已接单")) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(
        snapshot.items.some((x: any) => x.text === `工作区：${workspace.path}`),
      );
      await client.cancel(session.id);
    } finally {
      abort.abort();
      await worker;
      await app.close();
      for (const a of ["CLAUDE", "CODEX", "KIMI"])
        delete process.env[`DAISY_${a}_BIN`];
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
