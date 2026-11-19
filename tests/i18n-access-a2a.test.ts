/**
 * P6-23b (ADR-159): the access guard, the PIN, the outside face, the relay
 * and the A2A entry say their refusals in the asker's language — the
 * local API's and the A2A entry's `Accept-Language`, else the owner's —
 * with the same stable `code` in every language. Chinese stays as it was
 * (the tests' default language); English is checked by key words only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks } from "../packages/contracts/src/i18n-node.ts";
import { A2AError, callerT, rpcErrorBody, statusBody } from "../packages/daisy/src/a2a/errors.ts";
import { stateLabel } from "../packages/daisy/src/a2a/outgoing.ts";
import { validateExternal } from "../packages/daisy/src/access/faces.ts";
import { selfSignedWarning } from "../packages/daisy/src/access/outside-link.ts";
import { normalizeUiOrigin } from "../packages/daisy/src/access/ui-origins.ts";
import { parseRelayUrl } from "../packages/daisy/src/relay/config.ts";

const en = translator(shippedPacks(), "en");
const zh = translator(shippedPacks(), "zh-CN");

async function app() {
  const { createApp } = await import("../packages/daisy/src/app.ts");
  const root = mkdtempSync(join(tmpdir(), "daisy-i18n-access-"));
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  const ctx = await createApp({ dataDir: dir, workspaceHome: root, workspaceRoots: [root] });
  return {
    ctx,
    close: async () => {
      await ctx.app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("P6-23b: the guard's refusal (local API) by Accept-Language, the code the same", async () => {
  const a = await app();
  try {
    const zhR = await a.ctx.app.inject({ url: "/api/access" });
    assert.equal(zhR.statusCode, 401);
    assert.equal(zhR.json().code, "unauthenticated");
    assert.match(zhR.json().error, /没有有效的凭据/);
    const enR = await a.ctx.app.inject({ url: "/api/access", headers: { "accept-language": "en-US,en;q=0.9" } });
    assert.equal(enR.statusCode, 401);
    assert.equal(enR.json().code, "unauthenticated");
    assert.match(enR.json().error, /No valid credential/);
    assert.equal(enR.headers["content-language"], "en");
  } finally {
    await a.close();
  }
});

test("P6-23b: the A2A entry's refusal (its own error shape) by Accept-Language", async () => {
  const a = await app();
  try {
    const url = "/a2a/nobody/.well-known/agent-card.json";
    const zhR = await a.ctx.app.inject({ url, headers: { "a2a-version": "1.0" } });
    assert.equal(zhR.statusCode, 401);
    assert.match(zhR.json().error.message, /没有有效的凭据/);
    const enR = await a.ctx.app.inject({ url, headers: { "a2a-version": "1.0", "accept-language": "en" } });
    assert.equal(enR.statusCode, 401);
    assert.match(enR.json().error.message, /No valid credential/);
    assert.equal(enR.json().error.details[0].metadata.code, "unauthenticated");
  } finally {
    await a.close();
  }
});

test("P6-23b: a PIN refusal is said in the request's language (pin_not_set)", async () => {
  const a = await app();
  try {
    const h = { authorization: `Bearer ${a.ctx.issueToken()}` };
    const zhR = await a.ctx.app.inject({ method: "POST", url: "/api/pin/grant", headers: h, payload: { pin: "12345678" } });
    assert.equal(zhR.json().code, "pin_not_set", zhR.body);
    assert.match(zhR.json().error, /还没有设置 PIN.*daisy pin set/);
    const enR = await a.ctx.app.inject({
      method: "POST",
      url: "/api/pin/grant",
      headers: { ...h, "accept-language": "en" },
      payload: { pin: "12345678" },
    });
    assert.equal(enR.json().code, "pin_not_set");
    assert.match(enR.json().error, /No PIN is set yet.*daisy pin set/);
  } finally {
    await a.close();
  }
});

test("P6-23b: an A2A error is a key, said when written — English or Chinese, the reason the same", () => {
  const e = new A2AError("NOT_FOUND", { key: "server-a2a.notFound" }, { fields: [{ field: "x", description: { key: "server-a2a.field.invalid" } }] });
  assert.match(e.message, /No such agent/); // for the log
  const body = statusBody(e, en) as any;
  assert.match(body.error.message, /No such agent/);
  assert.equal(body.error.details[1].fieldViolations[0].description, "invalid");
  assert.match((statusBody(e, zh) as any).error.message, /没有这个 agent/);
  assert.match((rpcErrorBody(1, e, en) as any).error.message, /No such agent/);
  // Another side's words go out as they are.
  assert.equal((statusBody(new A2AError("INTERNAL", "as is"), en) as any).error.message, "as is");
  // The caller's language: Accept-Language, else the owner's.
  assert.equal(callerT({ headers: { "accept-language": "en" } }).lang, "en");
  assert.equal(callerT({ headers: { "accept-language": "zh-Hans-CN" } }).lang, "zh-CN");
});

test("P6-23b: checks return message keys — the outside face, allowed origins, the relay address — said in either language", () => {
  const bad = validateExternal({ host: "8.8.8.8", tls: false })!;
  assert.match(en.dynamic(bad.key, bad.params), /Plain HTTP/);
  assert.match(zh.dynamic(bad.key, bad.params), /明文 HTTP 只允许/);
  const o = normalizeUiOrigin("http://example.com") as any;
  assert.match(en.dynamic(o.error.key, o.error.params), /“http:\/\/example\.com”: plain http/);
  const r = parseRelayUrl("http://relay.example") as any;
  assert.match(en.dynamic(r.error.key, r.error.params), /must be https/);
  assert.match(selfSignedWarning("AB:CD", en), /AB:CD.*access show/);
  assert.match(selfSignedWarning(null, zh), /access show 打印的那个/);
  assert.equal(stateLabel("TASK_STATE_COMPLETED", en), "completed");
  assert.equal(stateLabel("TASK_STATE_COMPLETED", zh), "已完成");
  assert.equal(stateLabel("SOMETHING_NEW", en), "SOMETHING_NEW");
});
