/**
 * P1-10 (tests/plugin-seam.test.ts): a control plane and a Runner in a
 * process of their own, plugins as the environment says (DAISY_PLUGINS),
 * one turn on the fake CLI. Prints what the parent checks, as one JSON
 * line; the modules this process loaded are logged by plugin-seam-hooks.mjs.
 * Started by tests/fixtures/plugin-seam-run.ts.
 */
import { setup } from "./scheduler-harness.ts";
import { runnerReply } from "./runner-calls.ts";

/** The plugin variables to report per harness process (PLUGIN_SEAM_ENV_KEYS, comma-separated). */
const ENV_KEYS = (process.env.PLUGIN_SEAM_ENV_KEYS || "DAISY_TEST_VIA,DAISY_TEST_SESSION").split(",");

const h = await setup();
try {
  const s = await h.create("codex", "插件缝隙");
  const snap = await h.turn(s.id, "你好");
  // Hook 2's Runner call exists only with a plugin that takes events in
  // (P1-02: in process; over HTTP there is no /api/runner/* at all).
  const callbacks = await runnerReply(h.config.api, "/callbacks", {
    entries: [],
  });
  const callbacksHttp = await fetch(`${h.url}/api/runner/callbacks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries: [] }),
  });
  // P4-13: the core serves (its public health route) whatever is installed.
  const health = await fetch(`${h.url}/api/health`);
  // Every harness process started (the turn's, a title's …).
  const spawns = h
    .lines(h.spawns)
    .filter((x) => Array.isArray(x.argv) && !x.argv.includes("--version"));
  console.log(
    "RESULT " +
      JSON.stringify({
        status: snap.session.status,
        replies: snap.items
          .filter((x: any) => x.kind === "assistant")
          .map((x: any) => x.text),
        callbacks: callbacks.statusCode,
        callbacksHttp: callbacksHttp.status,
        health: health.status,
        env: spawns.map((x) => Object.fromEntries(ENV_KEYS.map((k) => [k, x[k] ?? null]))),
        session: s.id,
      }),
  );
} finally {
  await h.close();
}
process.exit(0);
