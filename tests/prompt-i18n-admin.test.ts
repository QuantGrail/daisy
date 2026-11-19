import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { GUIDE_LIMITS } from "../packages/contracts/src/guide.ts";
import { runnerInject } from "./fixtures/runner-calls.ts";
/**
 * P6-24 (ADR-159 §3, §6): the layered prompt's pages and errors speak the
 * request's language (`Accept-Language`), with the same stable `code`s;
 * the tests' default (zh-CN) is unchanged. Words stored for later display
 * (the edit history) are written in the language of the request that
 * wrote them.
 */
const ORG_DOC_ID = "DOC-0a1b2c3d4e5f";
const EN = { "accept-language": "en" };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-prompt-i18n-admin-"));
  const ctx = await createApp({
    pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    orgCore: { docId: ORG_DOC_ID, rawCommand: `team-cli get ${ORG_DOC_ID} --raw` },
  });
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  const uh = { authorization: `Bearer ${ctx.issueToken()}` };
  const req = async (method: string, url: string, payload?: any, headers: any = {}) => {
    const r = await inject({
      method: method as any,
      url,
      headers: { ...uh, ...headers },
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: r.statusCode, body: (r.body ? r.json() : null) as any };
  };
  const cat = (await req("GET", "/api/catalog")).body;
  const profile = cat.profiles.find((p: any) => p.agent === "claude");
  const create = async () =>
    (
      await req("POST", "/api/sessions", {
        title: "提示词",
        agent: "claude",
        profileId: profile.id,
        workspaceId: cat.workspaces[0].id,
      })
    ).body;
  return {
    ctx,
    req,
    create,
    close: async () => {
      await ctx.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a session's prompt view: English for an English request, Chinese by default", async () => {
  const f = await fixture();
  try {
    const s = await f.create();
    const en = await f.req("GET", `/api/sessions/${s.id}/prompt`, undefined, EN);
    assert.equal(en.status, 200);
    assert.match(en.body.layered.why, /layered prompt is not enabled yet/);
    assert.match(en.body.effectiveText, /not enabled for this session/);
    assert.match(en.body.effectText, /New conversations get it at once/);
    assert.ok(en.body.engineOwned.includes("Automatic memory"));
    assert.ok(en.body.perTurn.some((x: any) => x.title === "Task context"));
    assert.equal(en.body.apply.note, "The layered prompt is not enabled for this session");
    // No Chinese left in the words this file says (layer texts are the session's own).
    const said = JSON.stringify([en.body.layered, en.body.effectiveText, en.body.effectText, en.body.engineOwned, en.body.perTurn, en.body.apply]);
    assert.doesNotMatch(said, /[一-鿿]/);
    const zh = await f.req("GET", `/api/sessions/${s.id}/prompt`);
    assert.match(zh.body.layered.why, /分层提示词还没有启用/);
    assert.ok(zh.body.engineOwned.includes("自动记忆"));
  } finally {
    await f.close();
  }
});

test("errors keep their code and speak the request's language; the history is written in it", async () => {
  const f = await fixture();
  try {
    const long = "x".repeat(GUIDE_LIMITS.noteMax + 1);
    const en = await f.req("PUT", "/api/me/prompt", { note: long }, EN);
    assert.equal(en.status, 400);
    assert.equal(en.body.code, "prompt_note_too_long");
    assert.match(en.body.error, /The personal notes may be at most \d+ characters/);
    const zh = await f.req("PUT", "/api/me/prompt", { note: long });
    assert.equal(zh.body.code, "prompt_note_too_long");
    assert.match(zh.body.error, /个人补充说明最多/);
    // An admin's refusal: no authoritative core, so not on for everyone.
    const all = await f.req("PUT", "/api/admin/prompt-layers", { mode: "all" }, EN);
    assert.equal(all.status, 409);
    assert.equal(all.body.code, "org_core_unverified");
    assert.match(all.body.error, /cannot read the organisation's platform/);
    assert.doesNotMatch(all.body.error, /[一-鿿]/);
    // A change written by an English request: its history line is English.
    const saved = await f.req("PUT", "/api/me/prompt", { note: "be brief" }, EN);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.history[0].summary, "Wrote the personal notes");
    // The optional sections' titles are the request's too.
    assert.doesNotMatch(JSON.stringify(saved.body.optional), /[一-鿿]/);
    // The admin page: its words in English too.
    const admin = await f.req("GET", "/api/admin/prompt-layers", undefined, EN);
    assert.equal(admin.status, 200);
    assert.doesNotMatch(JSON.stringify([admin.body.alerts, admin.body.core.problem]), /[一-鿿]/);
  } finally {
    await f.close();
  }
});
