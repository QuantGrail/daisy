import { AGENT_IDS } from "../packages/contracts/src/acp-harnesses.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { MIGRATIONS } from "../packages/daisy/src/store/schema.ts";

// P1-03: no admin account and no ACCESS.md — the owner is the system
// account; the command line's credential is keys/cli-credential.
test("bootstrap can skip the local node / identities; no accounts, no ACCESS.md", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-bootstrap-"));
  try {
    const bare = await createApp({ pinGate: false,
      dataDir: join(dir, "bare"),
      bootstrapLocal: false,
    });
    const count = (t: string) =>
      bare.store.one(`SELECT COUNT(*) AS n FROM ${t}`).n;
    // No accounts: the tables are gone.
    for (const t of ["users", "tokens"])
      assert.equal(
        bare.store.one(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?",
          t,
        ).n,
        0,
        t,
      );
    assert.equal(count("nodes"), 0);
    assert.equal(count("workspaces"), 0);
    assert.equal(count("profiles"), 0);
    assert.equal(existsSync(join(dir, "bare", "runner.json")), false);
    assert.equal(existsSync(join(dir, "bare", "ACCESS.md")), false);
    await bare.app.close();
    // Started again: still nothing made (bootstrapLocal stays off).
    const again = await createApp({ pinGate: false,
      dataDir: join(dir, "bare"),
      bootstrapLocal: false,
    });
    assert.equal(again.store.one("SELECT COUNT(*) AS n FROM nodes").n, 0);
    await again.app.close();
    const full = await createApp({ pinGate: false,
      dataDir: join(dir, "full"),
      workspaceHome: dir,
    });
    const runner = JSON.parse(
      readFileSync(join(dir, "full", "runner.json"), "utf8"),
    );
    // P1-02: the in-process Runner's settings — no server URL, no token.
    assert.equal(runner.serverUrl, undefined);
    assert.equal(runner.token, undefined);
    assert.ok(
      full.store.one("SELECT id FROM nodes WHERE id=?", runner.nodeId),
    );
    // P4-10: one host-login identity per agent, every ACP harness included.
    assert.equal(
      full.store.one("SELECT COUNT(*) AS n FROM profiles").n,
      AGENT_IDS.length,
    );
    assert.equal(existsSync(join(dir, "full", "ACCESS.md")), false);
    await full.app.close();
    // A second start keeps the one node (bootstrap runs once).
    const full2 = await createApp({ pinGate: false,
      dataDir: join(dir, "full"),
      workspaceHome: dir,
    });
    assert.equal(full2.store.one("SELECT COUNT(*) AS n FROM nodes").n, 1);
    await full2.app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// P6-11 (ADR-156): a harness that appears after the first start (an extra
// ACP harness file, a new built-in after an update) gets its 「主机登录」
// identity at the next start; one the owner deleted is not made again.
test("a harness that appeared since the first start gets its host-login identity at the next start; a deleted one is not made again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-hostlogin-"));
  const data = join(dir, "data");
  const hostLogins = (s: any, agent: string) =>
    s.all("SELECT data FROM profiles").map((r: any) => JSON.parse(r.data)).filter((p: any) => p.agent === agent);
  try {
    // Settings the owner wrote before the very first start are kept.
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "runner.json"), JSON.stringify({ port: 29444, acpHarnesses: "x.json", agentBins: { kimi: "/k" } }));
    let a = await createApp({ pinGate: false, dataDir: data, workspaceHome: dir });
    const runner = JSON.parse(readFileSync(join(data, "runner.json"), "utf8"));
    assert.equal(runner.port, 29444);
    assert.equal(runner.acpHarnesses, "x.json");
    assert.deepEqual(runner.agentBins, { kimi: "/k" });
    assert.ok(runner.nodeId);
    for (const agent of AGENT_IDS) assert.equal(hostLogins(a.store, agent).length, 1, agent);
    // kimi stands in for a harness this Daisy did not know at its first
    // start (as one from an extra file): no identity, no record.
    a.store.run("DELETE FROM profiles WHERE json_extract(data,'$.agent')='kimi'");
    a.store.run("DELETE FROM host_login_agents WHERE agent='kimi'");
    // codex: the owner deleted its host-login identity.
    a.store.run("DELETE FROM profiles WHERE json_extract(data,'$.agent')='codex'");
    await a.app.close();
    a = await createApp({ pinGate: false, dataDir: data, workspaceHome: dir });
    const kimi = hostLogins(a.store, "kimi");
    assert.equal(kimi.length, 1);
    // P6-28: stored unnamed; said "kimi · host login" in the reader's language (tests/outsider-en.test.ts).
    assert.equal(kimi[0].label, "");
    assert.equal(kimi[0].nodeId, runner.nodeId);
    assert.equal(kimi[0].authMode, "subscription");
    assert.equal(kimi[0].configDir, "");
    assert.equal(hostLogins(a.store, "codex").length, 0, "not made again");
    assert.equal(hostLogins(a.store, "claude").length, 1, "nothing doubled");
    await a.app.close();
    // bootstrapLocal off: nothing is made.
    const bare = await createApp({ pinGate: false, dataDir: join(dir, "bare"), bootstrapLocal: false });
    assert.equal(bare.store.one("SELECT COUNT(*) AS n FROM profiles").n, 0);
    await bare.app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema step 15 counts every agent with an identity on a node as given (an upgraded Daisy does not double them)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const m of MIGRATIONS.filter((m) => m.version < 15)) db.exec(m.sql);
    const add = (id: string, node: string, agent: string) =>
      db.prepare("INSERT INTO profiles VALUES(?,?,?,?,?)").run(id, "owner", node, JSON.stringify({ id, agent }), "");
    add("p1", "n1", "claude");
    add("p2", "n1", "claude");
    add("p3", "n1", "acme");
    add("p4", "n2", "codex");
    db.exec(MIGRATIONS.find((m) => m.version === 15)!.sql);
    const rows = db.prepare("SELECT node_id, agent FROM host_login_agents ORDER BY node_id, agent").all();
    assert.deepEqual(rows.map((r: any) => `${r.node_id}/${r.agent}`), ["n1/acme", "n1/claude", "n2/codex"]);
  } finally {
    db.close();
  }
});
