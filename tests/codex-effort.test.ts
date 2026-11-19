// Codex efforts (max / ultra) and Fast come from Codex's own
// model catalog per model; the choice reaches Codex on thread/start and
// every turn/start. The catalog sample is a real codex-cli 0.157.1
// `model/list` answer (account fields dropped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { runNode, type NodeConfig } from "../packages/daisy/src/turns/worker.ts";
import {
  codexBaseline,
  codexStartsOverridden,
  codexTurnSettings,
} from "../packages/daisy/src/harness/codex.ts";
import { DaisyClient, DaisyError } from "../packages/client/src/index.ts";
import { packT } from "./ui-pack.ts";
import {
  modelChoices,
  effortWord,
  settingsError,
  tierName,
  SessionSettingsSchema,
  type Snapshot,
} from "../packages/contracts/src/index.ts";

const catalogFile = resolve("tests/fixtures/codex-model-list.json");
const catalog = JSON.parse(readFileSync(catalogFile, "utf8")).data;
const values = (c: ReturnType<typeof modelChoices>) =>
  c.efforts.map((e) => e.value);

test("Codex efforts and Fast follow the real catalog of the selected model", () => {
  const astra = modelChoices("codex", {
    models: catalog,
    model: "gpt-6-astra",
  });
  assert.equal(astra.fromCatalog, true);
  assert.deepEqual(values(astra), [
    "",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  assert.equal(astra.defaultEffort, "medium");
  assert.match(
    astra.efforts.find((e) => e.value === "ultra")!.description!,
    /delegation/,
  );
  assert.deepEqual(astra.tiers, [
    { id: "priority", name: "Fast", description: "2x speed, increased usage" },
  ]);
  // Luna has max but no ultra; still Fast.
  const luna = modelChoices("codex", { models: catalog, model: "gpt-6-luna" });
  assert.deepEqual(values(luna), ["", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(luna.tiers[0].id, "priority");
  // "" = the catalog's default model (isDefault).
  assert.deepEqual(
    values(modelChoices("codex", { models: catalog, model: "" })),
    values(astra),
  );
  // A model by id or by model name.
  assert.equal(
    modelChoices("codex", { models: catalog, model: "gpt-5.6-sol" })
      .defaultEffort,
    "low",
  );
  // Catalog not read / model not listed: a fallback, no Fast.
  for (const c of [
    modelChoices("codex", { model: "gpt-6-astra" }),
    modelChoices("codex", { models: catalog, model: "my-custom" }),
  ]) {
    assert.equal(c.fromCatalog, false);
    assert.deepEqual(values(c), ["", "low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(c.tiers, []);
  }
  // A saved choice stays visible (and can be turned off) without a catalog.
  const saved = modelChoices("codex", { effort: "ultra", tier: "priority" });
  assert.ok(values(saved).includes("ultra"));
  assert.deepEqual(saved.tiers, [{ id: "priority", name: "Fast" }]);
  assert.deepEqual(modelChoices("codex", { tier: "default" }).tiers, []);
  // Values the server would reject (a newer Codex) and odd tier ids are left out.
  const odd = modelChoices("codex", {
    models: [
      {
        id: "x",
        model: "x",
        supportedReasoningEfforts: [
          { reasoningEffort: "turbo", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
        serviceTiers: [
          { id: "-flag", name: "Bad" },
          { id: "default", name: "Standard" },
          { id: "flex", name: "Flex" },
        ],
      },
    ],
    model: "x",
  });
  assert.deepEqual(values(odd), ["", "high"]);
  assert.deepEqual(
    odd.tiers.map((t) => t.id),
    ["flex"],
  );
  // Other agents as before: Claude low..max, Kimi its thinking options.
  assert.deepEqual(values(modelChoices("claude")), [
    "",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(
    values(
      modelChoices("kimi", {
        configOptions: [
          { id: "thinking", options: [{ value: "off" }, { value: "on" }] },
        ],
      }),
    ),
    ["", "off", "on"],
  );
  assert.deepEqual(values(modelChoices("kimi")), ["", "low", "high", "max"]);
  assert.equal(tierName("priority", catalog), "Fast");
  assert.equal(tierName("priority"), "Fast");
  // The contract accepts ultra and tier ids, never a flag.
  assert.ok(
    SessionSettingsSchema.safeParse({
      reasoningEffort: "ultra",
      serviceTier: "priority",
    }).success,
  );
  // ultra / tiers are Codex's; a listed Codex model only its own.
  assert.match(settingsError("claude", { reasoningEffort: "ultra" })!, /Codex/);
  assert.match(settingsError("kimi", { serviceTier: "priority" })!, /Codex/);
  assert.equal(settingsError("claude", { reasoningEffort: "max" }), null);
  assert.equal(settingsError("claude", { serviceTier: "" }), null);
  const codex = (x: object) => settingsError("codex", x, catalog);
  assert.match(
    codex({ model: "gpt-6-luna", reasoningEffort: "ultra" })!,
    /gpt-6-luna/,
  );
  assert.equal(codex({ model: "gpt-6-astra", reasoningEffort: "ultra" }), null);
  assert.equal(codex({ model: "gpt-6-luna", serviceTier: "priority" }), null);
  assert.equal(codex({ model: "gpt-6-luna", serviceTier: "fast" }), null);
  assert.equal(codex({ model: "gpt-6-luna", serviceTier: "default" }), null);
  assert.match(codex({ model: "gpt-6-luna", serviceTier: "flex" })!, /flex/);
  // Not listed / no model / no catalog: not checked.
  assert.equal(codex({ model: "my-custom", reasoningEffort: "ultra" }), null);
  assert.equal(codex({ reasoningEffort: "ultra" }), null);
  assert.equal(
    settingsError("codex", { model: "gpt-6-luna", reasoningEffort: "ultra" }),
    null,
  );
  for (const bad of [
    { reasoningEffort: "turbo" },
    { serviceTier: "-c" },
    { serviceTier: "Fast" },
  ])
    assert.equal(SessionSettingsSchema.safeParse(bad).success, false);
  // P6-22: in English (the UI passes its translator), and the effort words.
  const en = packT("en");
  assert.equal(settingsError("claude", { reasoningEffort: "ultra" }, undefined, en), "Only Codex supports the ultra reasoning effort");
  assert.equal(
    settingsError("codex", { model: "gpt-6-luna", serviceTier: "flex" }, catalog, en),
    "Model gpt-6-luna does not support speed tier flex",
  );
  assert.equal(tierName("default", undefined, en), "Standard");
  assert.equal(tierName("default", undefined, packT("zh-CN")), "标准");
  assert.match(effortWord("high", en)!, /Deeper reasoning/);
  assert.equal(effortWord("high", packT("zh-CN")), "更深的推理，复杂问题");
  assert.equal(effortWord("", en), undefined);
});

test("Codex turn settings: overrides stick to the thread, so 默认 sends the baseline (config, the fresh thread's answer, or the catalog default)", () => {
  const none = { effort: false, tier: false },
    both = { effort: true, tier: true };
  // Baseline: config.toml first.
  const configured = codexBaseline(
    { model_reasoning_effort: "high", service_tier: "fast" },
    { reasoningEffort: "medium" },
    true,
    "low",
  );
  assert.deepEqual(configured, { effort: "high", tier: "priority" });
  // No config (managed identity, or config/read failed): a fresh thread's
  // answer; a resumed one's may be a saved override, so the catalog's.
  assert.deepEqual(codexBaseline({}, { reasoningEffort: "medium" }, true), {
    effort: "medium",
    tier: "default",
  });
  assert.deepEqual(
    codexBaseline(null, { reasoningEffort: "ultra" }, false, "low"),
    { effort: "low", tier: "default" },
  );
  assert.deepEqual(codexBaseline(null, { reasoningEffort: "ultra" }, false), {
    tier: "default",
  });
  // A resumed thread that restored Fast / ultra counts as overridden.
  const base = { effort: "medium", tier: "default" };
  assert.deepEqual(
    codexStartsOverridden(
      { reasoningEffort: "ultra", serviceTier: "priority" },
      base,
    ),
    both,
  );
  assert.deepEqual(
    codexStartsOverridden(
      { reasoningEffort: "medium", serviceTier: null },
      base,
    ),
    none,
  );
  assert.deepEqual(
    codexStartsOverridden(
      { serviceTier: "priority" },
      { effort: "high", tier: "priority" },
    ),
    none,
  );
  // Turns.
  assert.deepEqual(codexTurnSettings({}, base, none), {});
  assert.deepEqual(
    codexTurnSettings(
      { reasoningEffort: "ultra", serviceTier: "priority" },
      base,
      none,
    ),
    { effort: "ultra", serviceTier: "priority" },
  );
  // Back to 默认 after an override (this process or a restored one).
  assert.deepEqual(codexTurnSettings({}, base, both), {
    effort: "medium",
    serviceTier: "default",
  });
  assert.deepEqual(codexTurnSettings({}, configured, both), {
    effort: "high",
    serviceTier: "priority",
  });
  // Baseline effort unknown: only the tier can be reset.
  assert.deepEqual(codexTurnSettings({}, { tier: "default" }, both), {
    serviceTier: "default",
  });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, accept: (x: T) => boolean) {
  for (let i = 0; i < 150; i++) {
    const x = await read();
    if (accept(x)) return x;
    await delay(100);
  }
  throw Error("State timed out");
}
const idle = (x: Snapshot) =>
  !["queued", "running", "waiting"].includes(x.session.status);

test(
  "Codex ultra / Fast reach Codex on thread/start and turn/start, per conversation and per identity",
  { timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "daisy-codex-effort-")),
      record = join(dir, "record.jsonl");
    const ctx = await createApp({ pinGate: false,
      workspaceHome: dir,
      workspaceRoots: [dir],
      dataDir: dir,
    });
    const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const c = new DaisyClient(
      url,
      ctx.issueToken(),
    );
    const config: NodeConfig = JSON.parse(
      readFileSync(join(dir, "runner.json"), "utf8"),
    );
    config.api = ctx.runnerApi(config.nodeId);
    config.identityRoot ??= join(dir, "runner-state-root");
    process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
    process.env.DAISY_FIXTURE_RECORD_THREAD = record;
    process.env.DAISY_FIXTURE_CODEX_CATALOG = catalogFile;
    process.env.DAISY_FIXTURE_RESUME_SAVED = JSON.stringify({
      reasoningEffort: "ultra",
      serviceTier: "priority",
    });
    const controller = new AbortController();
    const worker = runNode(config, controller.signal);
    const records = () =>
      existsSync(record)
        ? readFileSync(record, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
    const turn = async (sid: string, text: string) => {
      const before = records().filter((r) => r.via === "turn/start").length;
      await c.send(sid, text);
      const waiting = await until(
        () => c.snapshot(sid),
        (x) => x.approvals.some((a) => a.status === "pending") || idle(x),
      );
      const a = waiting.approvals.find((a) => a.status === "pending");
      if (a) await c.approve(sid, a.id, a.options[0].id);
      await until(
        () => c.snapshot(sid),
        (x) => idle(x) && !x.approvals.some((a) => a.status === "pending"),
      );
      const turns = records().filter((r) => r.via === "turn/start");
      assert.equal(turns.length, before + 1);
      return turns.at(-1);
    };
    try {
      const cat = await c.catalog();
      const profile = cat.profiles.find((p) => p.agent === "codex")!;
      // Identity: ultra + Fast accepted; a later save without serviceTier
      // (an older client) keeps it; bad values are refused.
      await c.request(`/profiles/${profile.id}`, "PATCH", {
        model: "",
        reasoningEffort: "ultra",
        serviceTier: "priority",
      });
      await c.request(`/profiles/${profile.id}`, "PATCH", {
        model: "",
        reasoningEffort: "max",
      });
      let saved = (await c.catalog()).profiles.find(
        (p) => p.id === profile.id,
      )!;
      assert.equal(saved.reasoningEffort, "max");
      assert.equal(saved.serviceTier, "priority");
      for (const body of [
        { model: "", reasoningEffort: "turbo" },
        { model: "", serviceTier: "--flag" },
      ])
        await assert.rejects(
          () => c.request(`/profiles/${profile.id}`, "PATCH", body),
          (e: unknown) => e instanceof DaisyError && e.status === 400,
        );
      const s = await c.create({
        agent: "codex",
        title: "effort",
        profileId: profile.id,
        workspaceId: cat.workspaces[0].id,
      });
      // The catalog operation carries the per-model efforts / tiers.
      const ops = await c.operation(s.id, "models", {});
      const result = await until(
        () => c.operationStatus(ops.sessionId, ops.id),
        (r) => !!r.result,
      );
      const astra = result.result.models.find(
        (m: any) => m.id === "gpt-6-astra",
      );
      assert.ok(
        astra.supportedReasoningEfforts.some(
          (e: any) => e.reasoningEffort === "ultra",
        ),
      );
      assert.equal(astra.serviceTiers[0].id, "priority");
      await until(() => c.snapshot(s.id), idle);
      // First turn: the identity's max + Fast.
      let t = await turn(s.id, "Hello");
      const start = records().find((r) => r.via === "thread/start");
      assert.equal(start.serviceTier, "priority");
      assert.deepEqual([t.effort, t.serviceTier], ["max", "priority"]);
      let snap = await c.snapshot(s.id);
      assert.equal(snap.session.runtime?.effort, "max");
      assert.equal(snap.session.runtime?.serviceTier, "priority");
      // This conversation only: ultra at standard speed.
      await c.updateSession(s.id, {
        settings: { reasoningEffort: "ultra", serviceTier: "default" },
      });
      assert.deepEqual((await c.snapshot(s.id)).session.settings, {
        reasoningEffort: "ultra",
        serviceTier: "default",
      });
      t = await turn(s.id, "Think more");
      assert.deepEqual([t.effort, t.serviceTier], ["ultra", "default"]);
      snap = await c.snapshot(s.id);
      assert.equal(snap.session.runtime?.effort, "ultra");
      assert.equal(snap.session.runtime?.serviceTier, "default");
      // Back to the identity's, then the identity back to Codex's default:
      // the online process sends standard speed (the override sticks
      // otherwise).
      await c.updateSession(s.id, {
        settings: { reasoningEffort: "", serviceTier: "" },
      });
      assert.equal(
        (await c.snapshot(s.id)).session.settings?.serviceTier,
        undefined,
      );
      await c.request(`/profiles/${profile.id}`, "PATCH", {
        model: "",
        reasoningEffort: "",
        serviceTier: "",
      });
      t = await turn(s.id, "Plain");
      const processes = records().filter(
        (r) => r.via === "thread/start" || r.via === "thread/resume",
      ).length;
      // The same online process: standard speed and the baseline effort
      // (no config.toml value here: the catalog default of the default
      // model, GPT-6-Astra's medium) are sent explicitly.
      assert.equal(processes, 1);
      assert.equal(t.serviceTier, "default");
      assert.equal(t.effort, "medium");
      // After a restart the resumed thread comes back with a saved
      // ultra / Fast (DAISY_FIXTURE_RESUME_SAVED): the next turn resets it.
      await c.goOffline(s.id);
      await until(
        () => c.snapshot(s.id),
        (x) => x.session.live?.online === false,
      );
      t = await turn(s.id, "After restart");
      const resumed = records().filter((r) => r.via === "thread/resume");
      assert.equal(resumed.length, 1);
      assert.equal(resumed[0].serviceTier, undefined);
      // The whole native history is not shipped back on resume (frame limit).
      assert.equal(resumed[0].excludeTurns, true);
      assert.deepEqual([t.effort, t.serviceTier], ["medium", "default"]);
      snap = await c.snapshot(s.id);
      assert.equal(snap.session.runtime?.effort, "medium");
      assert.equal(snap.session.runtime?.serviceTier, "default");
      // A tier-only report (no model / effort known) is kept too.
      ctx.store.append(s.id, "native", {
        nativeId: "codex-native",
        serviceTier: "priority",
      });
      assert.deepEqual(
        { ...(await c.snapshot(s.id)).session.runtime, at: 0 },
        { serviceTier: "priority", at: 0 },
      );
      // The server checks against the catalog the session read: Luna has
      // no ultra; nothing is saved.
      const before = (await c.snapshot(s.id)).session.settings;
      await assert.rejects(
        () =>
          c.updateSession(s.id, {
            settings: { model: "gpt-6-luna", reasoningEffort: "ultra" },
          }),
        (e: unknown) =>
          e instanceof DaisyError &&
          e.status === 400 &&
          /gpt-6-luna/.test(e.message),
      );
      assert.deepEqual((await c.snapshot(s.id)).session.settings, before);
      await c.updateSession(s.id, {
        settings: { model: "gpt-6-astra", reasoningEffort: "ultra" },
      });
      // ultra / Fast are refused for other agents.
      const claude = cat.profiles.find((p) => p.agent === "claude")!;
      for (const body of [
        { model: "", reasoningEffort: "ultra" },
        { model: "", serviceTier: "priority" },
      ])
        await assert.rejects(
          () => c.request(`/profiles/${claude.id}`, "PATCH", body),
          (e: unknown) => e instanceof DaisyError && e.status === 400,
        );
      const other = await c.create({
        agent: "claude",
        title: "claude",
        profileId: claude.id,
        workspaceId: cat.workspaces[0].id,
      });
      for (const settings of [
        { reasoningEffort: "ultra" },
        { serviceTier: "priority" },
      ])
        await assert.rejects(
          () => c.updateSession(other.id, { settings }),
          (e: unknown) => e instanceof DaisyError && e.status === 400,
        );
      await c.updateSession(other.id, { settings: { reasoningEffort: "max" } });
      await assert.rejects(
        () => c.updateSession(s.id, { settings: { serviceTier: "-x" } }),
        (e: unknown) => e instanceof DaisyError && e.status === 400,
      );
    } finally {
      controller.abort();
      await worker.catch(() => {});
      await ctx.app.close();
      delete process.env.DAISY_CODEX_BIN;
      delete process.env.DAISY_FIXTURE_RECORD_THREAD;
      delete process.env.DAISY_FIXTURE_CODEX_CATALOG;
      delete process.env.DAISY_FIXTURE_RESUME_SAVED;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
