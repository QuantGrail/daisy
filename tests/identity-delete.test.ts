import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { id } from "../packages/daisy/src/store/index.ts";
import {
  resolveIdentity,
  retireIdentities,
} from "../packages/daisy/src/turns/identity.ts";
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";

// Identities could be created and logged in, but
// never deleted.
test("owner deletes an identity; running turns refuse; login cancelled; runner told to clean", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-identity-delete-"));
  const { app, store, issueToken, runnerApi } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  const inject = runnerInject(app, runnerApi);
  try {
    const runner = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
    const headers = { authorization: `Bearer ${issueToken()}` };
    const req = (
      url: string,
      method: any = "GET",
      payload?: any,
      h: Record<string, string> = headers,
    ) => inject({ url: "/api" + url, method, payload, headers: h });
    const rh = runnerHeaders(runner.nodeId);

    const p = (
      await req("/identities", "POST", {
        agent: "claude",
        nodeId: runner.nodeId,
        label: "独立账号",
      })
    ).json();
    const cat = (await req("/catalog")).json();
    const s = (
      await req("/sessions", "POST", {
        agent: "claude",
        title: "uses it",
        profileId: p.id,
        workspaceId: cat.workspaces[0].id,
      })
    ).json();
    assert.ok(s.id);

    // A turn in flight refuses the delete.
    const jid = id();
    store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,context,terminal) VALUES(?,?,?,?,?,?,?,?,?,?)",
      jid,
      s.id,
      runner.nodeId,
      "r1",
      "hi",
      "[]",
      "running",
      Date.now(),
      null,
      null,
    );
    const busy = await req(`/profiles/${p.id}`, "DELETE");
    assert.equal(busy.statusCode, 409);
    assert.match(busy.json().error ?? busy.body, /运行中/);
    store.run("UPDATE jobs SET status='done' WHERE id=?", jid);

    // An unfinished login does not block: it is cancelled.
    const login = (await req(`/profiles/${p.id}/login`, "POST", {})).json();
    assert.equal(login.status, "queued");
    const del = await req(`/profiles/${p.id}`, "DELETE");
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { ok: true, managed: true });
    assert.equal(
      store.one("SELECT status FROM logins WHERE id=?", login.id).status,
      "cancelled",
    );
    assert.equal(
      store.one("SELECT id FROM profiles WHERE id=?", p.id),
      undefined,
    );
    assert.ok(
      !(await req("/catalog")).json().profiles.some((x: any) => x.id === p.id),
    );
    assert.equal((await req(`/profiles/${p.id}`, "DELETE")).statusCode, 404);
    assert.ok(
      store.one(
        "SELECT * FROM audit WHERE action='profile.delete' AND target=?",
        p.id,
      ),
    );

    // The old conversation stays readable but cannot send.
    const send = await req(`/sessions/${s.id}/messages`, "POST", {
      text: "again",
      requestId: "request-0002",
    });
    assert.equal(send.statusCode, 409);
    assert.match(send.body, /已删除或重新分配/);

    // The runner of that node learns which CLI directory to remove.
    const beat = (
      await req("/runner/sync", "POST", { capabilities: {} }, rh)
    ).json();
    assert.deepEqual(beat.retiredIdentities, [p.id]);

    // A host login (configDir "") is never listed: the member's own ~/.claude
    // is not Daisy's to delete.
    const host = (
      await req("/profiles", "POST", {
        label: "本机登录",
        nodeId: runner.nodeId,
        agent: "codex",
        authMode: "subscription",
        configDir: "",
      })
    ).json();
    const hd = await req(`/profiles/${host.id}`, "DELETE");
    assert.deepEqual(hd.json(), { ok: true, managed: false });
    assert.deepEqual(
      (await req("/runner/sync", "POST", { capabilities: {} }, rh)).json()
        .retiredIdentities,
      [p.id],
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner removes only retired managed identity directories of its own node", () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-identity-root-"));
  try {
    const node = "node-1";
    const keep = resolveIdentity(
      { id: "keep-1", configDir: "managed:keep-1" } as any,
      node,
      root,
    ).configDir!;
    const gone = resolveIdentity(
      { id: "gone-1", configDir: "managed:gone-1" } as any,
      node,
      root,
    ).configDir!;
    writeFileSync(join(gone, ".credentials.json"), "secret");
    const otherNode = join(root, "node-2", "gone-1");
    mkdirSync(otherNode, { recursive: true });
    const removed = retireIdentities(
      ["gone-1", "../node-2/gone-1", "missing-1", 7],
      node,
      root,
    );
    assert.deepEqual(removed, ["gone-1", "missing-1"]);
    assert.equal(existsSync(gone), false);
    assert.equal(existsSync(keep), true);
    assert.equal(existsSync(otherNode), true);
    assert.deepEqual(retireIdentities(undefined, node, root), []);
    assert.deepEqual(retireIdentities(["x"], "../evil", root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
