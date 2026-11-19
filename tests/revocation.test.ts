import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../packages/daisy/src/app.ts";

// P1-03: node revocation (DELETE /api/nodes/:id) is gone with machine
// management; what stays is the workspace path rule.
test("workspace registration needs an absolute path inside the node's roots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-ws-path-")),
    root = join(dir, "root");
  mkdirSync(root);
  const { app, store, issueToken } = await createApp({ pinGate: false,
    workspaceHome: root,
    workspaceRoots: [root],
    dataDir: join(dir, "data"),
  });
  try {
    const A = { authorization: `Bearer ${issueToken()}` };
    const nodeId = store.one("SELECT id FROM nodes").id;
    const post = (path: string) =>
      app.inject({
        method: "POST",
        url: "/api/workspaces",
        headers: A,
        payload: { nodeId, label: "w", path },
      });
    for (const bad of ["relative/../../etc", "~/x", "./x", "x"])
      assert.equal((await post(bad)).statusCode, 400, bad);
    // Before the node reports its roots only the shape is checked; the
    // stored path is normalised.
    const early = await post(root + "/a/../b/");
    assert.equal(early.statusCode, 200);
    assert.equal(early.json().path, join(root, "b"));
    // Once the node reported its roots, paths outside them are refused.
    store.run(
      "UPDATE nodes SET capabilities=? WHERE id=?",
      JSON.stringify({ filesystem: { home: root, roots: [root] } }),
      nodeId,
    );
    for (const bad of ["/etc", root + "/../etc", root + "-other"])
      assert.equal((await post(bad)).statusCode, 400, bad);
    assert.equal((await post(root)).statusCode, 200);
    assert.equal((await post(root + "/deep/dir")).statusCode, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
