/**
 * ADR-152 (P6-02, ADR-105-6 and siblings): contract values that said
 * "harbor" are written in their new spelling — the capability value
 * `fallback`, Daisy's scheduler items (`source: "scheduler"`, ids
 * `scheduler:<id>`, types `scheduler_bash` / `scheduler_monitor`,
 * `session.schedulerPending`), a rewind's `files.via: "fallback"` — and
 * every reader still takes the old spelling: rows stored before the rename
 * and reports from an older Runner come out of the API in the new one.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import {
  capabilitiesFor,
  isFallback,
  normalizeCapabilityValues,
  normalizeNodeCapabilities,
  normalizeSupport,
} from "../packages/contracts/src/agent-capabilities.ts";
import { AGENT_STOP } from "../packages/contracts/src/agent-stop.ts";
import { featuresFor } from "../packages/contracts/src/agent-features.ts";
import {
  normalizeLiveTimer,
  normalizeSessionRecord,
  schedulerItemId,
  schedulerPendingOf,
} from "../packages/contracts/src/live.ts";
import {
  backgroundCount,
  backgroundKind,
  backgroundOf,
  backgroundSource,
} from "../packages/ui/src/present.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import { PRODUCT_NAME } from "../packages/contracts/src/names.ts";
import {
  ownNode,
  runnerHeaders,
  runnerInject,
} from "./fixtures/runner-calls.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";
import { uiLang } from "./ui-pack.ts";

// ADR-159 §8: the UI speaks Chinese in these assertions.
uiLang("zh-CN");

/** A report as a Runner before the rename wrote it. */
const oldSpelling = (x: unknown) =>
  JSON.parse(JSON.stringify(x).replaceAll('"fallback"', '"harbor"'));
const hasOld = (x: unknown) => JSON.stringify(x).includes('"harbor"');

test("capability values: `fallback` is written; the old `harbor` reads as it", () => {
  const codex = capabilitiesFor("codex", "codex-cli 0.157.1");
  assert.equal(codex.rewind!.files, "fallback");
  assert.equal(codex.input.afterTurn.support, "fallback");
  assert.equal(AGENT_STOP.codex!.commands, "fallback");
  assert.ok(!hasOld(codex) && !hasOld(AGENT_STOP));

  assert.equal(normalizeSupport("harbor"), "fallback");
  assert.equal(normalizeSupport("native"), "native");
  assert.ok(isFallback("harbor") && isFallback("fallback"));
  assert.ok(!isFallback("native") && !isFallback(undefined));

  const old = oldSpelling(codex);
  assert.ok(hasOld(old));
  assert.deepEqual(normalizeCapabilityValues(old), codex);
  // Copy on write: a report already in the new spelling is the same object.
  assert.equal(normalizeCapabilityValues(codex), codex);
  // Only support values: an ACP harness id, a mode, a `via` stay as they are.
  const odd = {
    version: 1,
    agent: "harbor",
    input: { steer: { support: "harbor", via: "harbor" } },
    readOnly: { support: "native", opts: { mode: "harbor" } },
    features: { steer: "harbor" },
  };
  assert.deepEqual(normalizeCapabilityValues(odd), {
    version: 1,
    agent: "harbor",
    input: { steer: { support: "fallback", via: "harbor" } },
    readOnly: { support: "native", opts: { mode: "harbor" } },
    features: { steer: "fallback" },
  });

  const node = {
    filesystem: { roots: ["/x"] },
    agentFeatures: { codex: old },
    agentStop: oldSpelling(AGENT_STOP),
  };
  const n = normalizeNodeCapabilities(node);
  assert.ok(!hasOld(n));
  assert.deepEqual(n.filesystem, node.filesystem);
  assert.deepEqual(n.agentStop, AGENT_STOP);
  // The flat map and every route read the old report as the new one.
  assert.deepEqual(
    featuresFor({ agentFeatures: { codex: old } }, "codex"),
    featuresFor({ agentFeatures: { codex } }, "codex"),
  );
  assert.equal(
    featuresFor({ agentFeatures: { codex: old } }, "codex").rewindFiles,
    "fallback",
  );
});

test("scheduler items: the new spelling is written; old ids, sources, types and the old field read as new", () => {
  const old = {
    id: "harbor:s1",
    kind: "task" as const,
    label: "x",
    source: "harbor",
    type: "harbor_bash",
  } as any;
  const now = normalizeLiveTimer(old);
  assert.deepEqual({ ...now }, {
    id: "scheduler:s1",
    kind: "task",
    label: "x",
    source: "scheduler",
    type: "scheduler_bash",
  });
  assert.equal(normalizeLiveTimer(now), now);
  const agentOwn = { id: "t1", kind: "task" as const, label: "y", type: "local_bash" };
  assert.equal(normalizeLiveTimer(agentOwn), agentOwn);
  assert.equal(
    normalizeLiveTimer({ ...old, type: "harbor_monitor" }).type,
    "scheduler_monitor",
  );

  assert.equal(schedulerItemId("scheduler:s1"), "s1");
  assert.equal(schedulerItemId("harbor:s1"), "s1");
  assert.equal(schedulerItemId("scheduler:"), null);
  assert.equal(schedulerItemId("toolu_1"), null);

  const record = { id: "s", title: "t", harborPending: [old] };
  assert.deepEqual(schedulerPendingOf(record), [now]);
  assert.deepEqual(schedulerPendingOf({ schedulerPending: [now] }), [now]);
  assert.deepEqual(schedulerPendingOf(undefined), []);
  const fixed = normalizeSessionRecord(record) as any;
  assert.deepEqual(fixed, { id: "s", title: "t", schedulerPending: [now] });
  assert.equal(
    normalizeSessionRecord({ id: "s", harborPending: [] }).hasOwnProperty(
      "harborPending",
    ),
    false,
  );
  const clean = { id: "s", schedulerPending: [now] };
  assert.equal(normalizeSessionRecord(clean), clean);

  // The UI reads a snapshot from an older server the same way.
  const offline = { live: { online: false }, harborPending: [old] } as any;
  assert.equal(backgroundCount(offline), 1);
  assert.deepEqual(backgroundOf(offline), [now]);
  assert.equal(backgroundSource(old, "codex"), PRODUCT_NAME);
  assert.deepEqual(backgroundKind(old), { icon: "▣", kind: "后台命令" });
  assert.deepEqual(backgroundKind(now), { icon: "▣", kind: "后台命令" });
  assert.deepEqual(backgroundKind({ kind: "task", type: "harbor_monitor" }), {
    icon: "◉",
    kind: "监视",
  });
});

test("client: an older server's stop answer `source: \"harbor\"` is given as `scheduler`", async () => {
  for (const source of ["harbor", "scheduler", "agent"]) {
    const c = new DaisyClient("http://daisy.test", "t", {
      fetch: (async () =>
        new Response(JSON.stringify({ ok: true, stopped: true, source }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as any,
    });
    const r = await c.stopBackground("s1", "harbor:x");
    assert.equal(r.source, source === "agent" ? "agent" : "scheduler");
  }
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function fixture(caps: any) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-aliases-"));
  dirs.push(dir);
  const ctx = await createApp({
    pinGate: false,
    dataDir: dir,
    bootstrap: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  const auth = { authorization: "Bearer " + ctx.issueToken() };
  const call = (method: any, url: string, payload?: any, headers: any = auth) =>
    inject({ method, url: "/api" + url, payload, headers });
  const node = ownNode(ctx.store, OWNER_ID, "alice", "remote");
  const nh = runnerHeaders(node.nodeId);
  const synced = await call("POST", "/runner/sync", { capabilities: caps }, nh);
  assert.equal(synced.statusCode, 200, synced.body);
  const w = (
    await call("POST", "/workspaces", { nodeId: node.id, label: "w", path: dir })
  ).json();
  const p = (
    await call("POST", "/profiles", {
      nodeId: node.id,
      agent: "codex",
      label: "local",
      authMode: "subscription",
    })
  ).json();
  const s = (
    await call("POST", "/sessions", {
      title: "aliases",
      agent: "codex",
      workspaceId: w.id,
      profileId: p.id,
    })
  ).json();
  return { ctx, store: ctx.store, call, node, nh, s };
}

test("node capabilities: an older Runner's report is stored and served as `fallback`, and so is a row stored before", async () => {
  const codex = capabilitiesFor("codex", "codex-cli 0.157.1");
  const f = await fixture({
    agentFeatures: { codex: oldSpelling(codex) },
    agentStop: oldSpelling(AGENT_STOP),
  });
  try {
    const row = () =>
      f.store.one("SELECT capabilities FROM nodes WHERE id=?", f.node.id)
        .capabilities;
    // Written in the new spelling by /runner/sync.
    assert.ok(!row().includes('"harbor"'));
    assert.equal(JSON.parse(row()).agentFeatures.codex.rewind.files, "fallback");
    // A row stored before the rename (no sync since).
    f.store.run(
      "UPDATE nodes SET capabilities=? WHERE id=?",
      JSON.stringify({ agentFeatures: { codex: oldSpelling(codex) } }),
      f.node.id,
    );
    assert.ok(row().includes('"harbor"'));
    const cat = (await f.call("GET", "/catalog")).json();
    const n = cat.nodes.find((x: any) => x.id === f.node.id);
    assert.ok(n, "the node is in the catalog");
    assert.ok(!hasOld(n.capabilities));
    assert.equal(n.capabilities.agentFeatures.codex.rewind.files, "fallback");
    const snap = (await f.call("GET", `/sessions/${f.s.id}`)).json();
    assert.equal(snap.rewindFiles, "fallback");
    assert.equal(snap.features.rewindFiles, "fallback");
    assert.ok(!hasOld(snap.features));
  } finally {
    await f.ctx.app.close();
  }
});

test("session record: `harborPending` stored before is served as `schedulerPending`, and its items stop by either id", async () => {
  const f = await fixture({
    agentFeatures: { codex: capabilitiesFor("codex", "codex-cli 0.157.1") },
  });
  try {
    const schedule = async (label: string) => {
      const made = await f.call("POST", `/sessions/${f.s.id}/schedules`, {
        kind: "wakeup",
        delaySeconds: 600,
        prompt: label,
        label,
      });
      assert.equal(made.statusCode, 200, made.body);
      return made.json().schedule.id as string;
    };
    const sched = await schedule("look again");
    const other = await schedule("look later");
    const read = () =>
      JSON.parse(
        f.store.one("SELECT data FROM sessions WHERE id=?", f.s.id).data,
      );
    const fresh = read();
    // Written in the new spelling.
    assert.equal(fresh.harborPending, undefined);
    assert.deepEqual(
      fresh.schedulerPending.map((t: any) => [t.id, t.source]),
      [
        [`scheduler:${sched}`, "scheduler"],
        [`scheduler:${other}`, "scheduler"],
      ],
    );
    // The record as an older Daisy stored it (plus an old background command).
    const { schedulerPending, ...rest } = fresh;
    const oldItems = [
      ...schedulerPending.map((t: any) => ({
        ...t,
        id: t.id.replace(/^scheduler:/, "harbor:"),
        source: "harbor",
      })),
      {
        id: "harbor:gone",
        kind: "task",
        label: "sleep",
        source: "harbor",
        type: "harbor_bash",
        command: "sleep 9",
      },
    ];
    f.store.run(
      "UPDATE sessions SET data=? WHERE id=?",
      JSON.stringify({ ...rest, harborPending: oldItems }),
      f.s.id,
    );
    const snap = (await f.call("GET", `/sessions/${f.s.id}`)).json();
    const session = snap.session || snap;
    assert.equal(session.harborPending, undefined);
    assert.ok(!hasOld(session.schedulerPending));
    assert.deepEqual(
      session.schedulerPending.map((t: any) => [t.id, t.source, t.type]),
      [
        [`scheduler:${sched}`, "scheduler", undefined],
        [`scheduler:${other}`, "scheduler", undefined],
        ["scheduler:gone", "scheduler", "scheduler_bash"],
      ],
    );
    const list = (await f.call("GET", "/sessions")).json();
    const listed = (list.items || list).find((x: any) => x.id === f.s.id);
    assert.equal(listed.harborPending, undefined);
    assert.equal(listed.schedulerPending.length, 3);
    // Stop by the new id and by the old id a client may still hold.
    for (const tid of [`harbor:${other}`, `scheduler:${sched}`]) {
      const stop = await f.call(
        "POST",
        `/sessions/${f.s.id}/background/${encodeURIComponent(tid)}/stop`,
        {},
      );
      assert.equal(stop.statusCode, 200, stop.body);
      assert.equal(stop.json().source, "scheduler");
    }
    // The scheduler rewrote the record: the new name only.
    const after = read();
    assert.equal(after.harborPending, undefined);
    assert.ok(!hasOld(after));
  } finally {
    await f.ctx.app.close();
  }
});

test("rewind result: `files.via: \"harbor\"` stored before is served as `fallback`", async () => {
  const f = await fixture({
    agentFeatures: { codex: capabilitiesFor("codex", "codex-cli 0.157.1") },
  });
  try {
    const jid = "job-old-rewind";
    f.store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created) VALUES(?,?,?,?,?,?,?,?)",
      jid,
      f.s.id,
      f.node.id,
      "req-old-rewind",
      "",
      "[]",
      "done",
      Date.now(),
    );
    f.store.run(
      "INSERT INTO job_operations(job_id,data,result) VALUES(?,?,?)",
      jid,
      JSON.stringify({ name: "rewind", args: { count: 1, files: true } }),
      JSON.stringify({
        ok: true,
        files: { reverted: true, via: "harbor", filesChanged: ["a.txt"] },
      }),
    );
    const r = await f.call("GET", `/sessions/${f.s.id}/operations/${jid}`);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().result.files.via, "fallback");
    assert.deepEqual(r.json().result.files.filesChanged, ["a.txt"]);
  } finally {
    await f.ctx.app.close();
  }
});
