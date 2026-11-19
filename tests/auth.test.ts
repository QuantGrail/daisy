import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";
test("managed login: one active challenge, node lease and encrypted code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-auth-"));
  const { app, store, issueToken, runnerApi } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  const inject = runnerInject(app, runnerApi);
  try {
    const token = issueToken();
    const runner = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
    const headers = { authorization: `Bearer ${token}` };
    const req = async (
      url: string,
      method: any = "GET",
      payload?: any,
      h: Record<string, string> = headers,
    ) => inject({ url: "/api" + url, method, payload, headers: h });
    const p = (
      await req("/identities", "POST", {
        agent: "claude",
        nodeId: runner.nodeId,
        label: "isolated",
      })
    ).json();
    assert.equal(p.configDir, `managed:${p.id}`);
    assert.equal(
      (
        await req(`/profiles/${p.id}`, "PATCH", {
          model: "test-model",
          reasoningEffort: "high",
        })
      ).statusCode,
      200,
    );
    const j = (await req(`/profiles/${p.id}/login`, "POST", {})).json();
    assert.equal(j.status, "queued");
    assert.equal(
      (await req(`/profiles/${p.id}/login`, "POST", {})).json().id,
      j.id,
    );
    const rh = runnerHeaders(runner.nodeId);
    const claimed = (await req("/runner/logins/claim", "POST", {}, rh)).json()
      .login;
    const leaseHeaders = { ...rh, "x-lease": claimed.lease };
    assert.equal(
      (
        await req(
          `/runner/logins/${j.id}/update`,
          "POST",
          { status: "waiting", url: "https://evil.example/x" },
          leaseHeaders,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await req(
          `/runner/logins/${j.id}/update`,
          "POST",
          {
            status: "waiting",
            url: "https://claude.ai/oauth/authorize",
            needsInput: true,
          },
          leaseHeaders,
        )
      ).statusCode,
      200,
    );
    await req(`/logins/${j.id}/input`, "POST", { code: "CODE-secret#state" });
    assert.ok(
      !store
        .one("SELECT input FROM logins WHERE id=?", j.id)
        .input.includes("CODE-secret"),
    );
    const pulse = (
      await req(`/runner/logins/${j.id}/pulse`, "POST", {}, leaseHeaders)
    ).json();
    assert.equal(pulse.code, "CODE-secret#state");
    assert.equal(
      (
        await req(`/runner/logins/${j.id}/pulse`, "POST", {}, leaseHeaders)
      ).json().code,
      null,
    );
    await req(`/logins/${j.id}/cancel`, "POST", {});
    assert.equal(
      (
        await req(
          `/runner/logins/${j.id}/update`,
          "POST",
          { status: "complete" },
          leaseHeaders,
        )
      ).statusCode,
      409,
    );
    const host = store
      .all("SELECT data FROM profiles")
      .map((r) => JSON.parse(r.data))
      .find((p) => !p.configDir);
    assert.equal(
      (await req(`/profiles/${host.id}/login`, "POST", {})).statusCode,
      400,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("official-protocol login runner writes independent identity and completes device flow", async () => {
  const { executeLogin } = await import("../packages/daisy/src/turns/login.ts");
  const { resolve } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "daisy-login-runner-"));
  const { app, store, issueToken, runnerApi } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  const inject = runnerInject(app, runnerApi);
  process.env.DAISY_CODEX_BIN = resolve("tests/fixtures/agent.cjs");
  process.env.DAISY_FIXTURE_LOGIN_DELAY_MS = "80";
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 }),
      token = issueToken();
    const headers = { authorization: `Bearer ${token}` },
      runner = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
    const p = (
      await inject({
        url: "/api/identities",
        method: "POST",
        headers,
        payload: { agent: "codex", nodeId: runner.nodeId, label: "login-test" },
      })
    ).json();
    const login = (
      await inject({
        url: `/api/profiles/${p.id}/login`,
        method: "POST",
        headers,
        payload: {},
      })
    ).json();
    const claimed = (
      await inject({
        url: "/api/runner/logins/claim",
        method: "POST",
        headers: runnerHeaders(runner.nodeId),
        payload: {},
      })
    ).json().login;
    await executeLogin(
      {
        ...runner,
        api: runnerApi(runner.nodeId),
        identityRoot: join(dir, "identities"),
      },
      claimed,
      new AbortController().signal,
    );
    const result = (
      await inject({ url: `/api/logins/${login.id}`, headers })
    ).json();
    assert.equal(result.status, "complete");
    assert.equal(result.userCode, undefined);
    assert.equal(result.url, undefined);
  } finally {
    delete process.env.DAISY_CODEX_BIN;
    delete process.env.DAISY_FIXTURE_LOGIN_DELAY_MS;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
