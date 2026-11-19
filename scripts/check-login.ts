/** Starts official login challenges in temporary, isolated directories; never authorizes an account. */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { executeLogin } from "../packages/daisy/src/turns/login.ts";
const dir = mkdtempSync(join(tmpdir(), "daisy-real-login-"));
const { app, store, issueToken, runnerApi } = await createApp({ pinGate: false,
  workspaceHome: dir,
  workspaceRoots: [dir],
  dataDir: dir,
});
const results: any[] = [];
try {
  const url = await app.listen({ host: "127.0.0.1", port: 0 }),
    token = issueToken(),
    headers = { authorization: `Bearer ${token}` };
  const config = {
    ...JSON.parse(readFileSync(join(dir, "runner.json"), "utf8")),
    identityRoot: join(dir, "identities"),
  };
  for (const agent of ["claude", "codex", "kimi"]) {
    const profile = (
      await app.inject({
        url: "/api/identities",
        method: "POST",
        headers,
        payload: {
          agent,
          nodeId: config.nodeId,
          label: "temporary login probe",
        },
      })
    ).json();
    const login = (
      await app.inject({
        url: `/api/profiles/${profile.id}/login`,
        method: "POST",
        headers,
        payload: {},
      })
    ).json();
    // P1-02: the Runner's calls are in process (was POST /api/runner/…).
    config.api = runnerApi(config.nodeId);
    const { login: claim } = await config.api("/logins/claim", {});
    const abort = new AbortController(),
      work = executeLogin(config, claim, abort.signal);
    let row: any;
    for (let n = 0; n < 250; n++) {
      await new Promise((r) => setTimeout(r, 100));
      row = store.one("SELECT status,data FROM logins WHERE id=?", login.id);
      if (["waiting", "complete", "error"].includes(row.status)) break;
    }
    const data = JSON.parse(row.data);
    results.push({
      agent,
      status: row.status,
      officialHost: data.url ? new URL(data.url).hostname : null,
      hasUserCode: !!data.userCode,
      needsInput: !!data.needsInput,
      message: data.message,
    });
    await app.inject({
      url: `/api/logins/${login.id}/cancel`,
      method: "POST",
      headers,
      payload: {},
    });
    abort.abort();
    await work;
    console.log(JSON.stringify(results.at(-1)));
  }
  mkdirSync(resolve("artifacts"), { recursive: true });
  writeFileSync(
    resolve("artifacts/login-check.json"),
    JSON.stringify(results, null, 2),
  );
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
