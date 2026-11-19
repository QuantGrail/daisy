/**
 * P2-01 / P2-02 tests: a Daisy (createApp, a PIN stand-in) next to a fake
 * external issuer (fake-issuer.ts), helpers to configure one in the other
 * through the API as the owner would (command line + PIN), and a running
 * turn whose AI working credential the tests use.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../packages/daisy/src/app.ts";
import { PIN_GRANT_HEADER } from "../../packages/daisy/src/access/pin-seam.ts";
import { pinDouble } from "./pin-double.ts";
import { fakeIssuer, type FakeIssuer } from "./fake-issuer.ts";
import { runnerHeaders, runnerInject } from "./runner-calls.ts";

export const OWNER_SUB = "user:zz-owner";
export const OTHER_SUB = "user:someone-else";

export async function daisy(o: { dir?: string; issuer?: FakeIssuer; relay?: import("../../packages/daisy/src/app/context.ts").AppOptions["relay"] } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "daisy-issuer-"));
  const pin = pinDouble();
  const ctx = await createApp({
    pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    sharedHost: () => false,
    peerIsOwner: () => true,
    pin,
    ...(o.relay ? { relay: o.relay } : {}),
  });
  const cli = readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim();
  const iss = o.issuer ?? (await fakeIssuer());
  const asCli = { authorization: `Bearer ${cli}` };
  const withPin = () => ({ ...asCli, [PIN_GRANT_HEADER]: pin.grant("246810", "cli").grant });
  const inject = runnerInject(ctx.app, ctx.runnerApi);
  const urn = ctx.access.ai.urn;
  /** A token the fake issuer signs for this Daisy (aud = its URN). */
  const tokenFor = (sub: string, extra: Record<string, unknown> = {}, opt: Parameters<FakeIssuer["sign"]>[1] = {}) =>
    iss.sign({ sub, aud: urn, ...extra }, opt);
  const configure = (body: Record<string, unknown> = {}, headers: Record<string, string> = withPin()) =>
    ctx.app.inject({
      method: "PUT",
      url: "/api/access/issuer",
      headers,
      payload: { issuer: iss.issuer, ownerSubject: OWNER_SUB, ...body },
    });
  const get = (url: string, token: string, more: Record<string, string> = {}) =>
    ctx.app.inject({ url, headers: { authorization: `Bearer ${token}`, ...more } });
  async function close() {
    await ctx.app.close();
    if (!o.issuer) await iss.close();
    if (!o.dir) rmSync(dir, { recursive: true, force: true });
  }
  return { dir, pin, ctx, cli, iss, asCli, withPin, inject, urn, tokenFor, configure, get, close };
}
export type Daisy = Awaited<ReturnType<typeof daisy>>;

/** Two sessions, a running turn in the first; its AI working credential. */
export async function runningTurn(s: Daisy) {
  const { ctx, inject, dir } = s;
  const h = { authorization: `Bearer ${ctx.issueToken()}` };
  const cat = (await inject({ url: "/api/catalog", headers: h })).json();
  const mk = async () =>
    (
      await inject({
        method: "POST",
        url: "/api/sessions",
        headers: h,
        payload: {
          agent: "claude",
          workspaceId: cat.workspaces[0].id,
          profileId: cat.profiles.find((p: any) => p.agent === "claude").id,
        },
      })
    ).json();
  const own = await mk(),
    other = await mk();
  await inject({
    method: "POST",
    url: `/api/sessions/${own.id}/messages`,
    headers: h,
    payload: { text: "hi", requestId: "req-issuer-0001" },
  });
  const nodeId = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8")).nodeId;
  const claimed = (
    await inject({ method: "POST", url: "/api/runner/claim", payload: {}, headers: runnerHeaders(nodeId) })
  ).json();
  assert.equal(claimed.job.session.id, own.id);
  const ai = readFileSync(claimed.job.aiCredential.file, "utf8").trim();
  return { own: own.id as string, other: other.id as string, ai, job: claimed.job };
}
