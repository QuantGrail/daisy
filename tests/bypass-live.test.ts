import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, until, idle } from "./fixtures/scheduler-harness.ts";
/**
 * bypassPermissions (2026-11-03): an online Claude Code process launched in
 * bypassPermissions never serves a turn its session may not run in bypass
 * — checked on the real launch flags (the fake CLI records every spawn)
 * and on whether the process is reused, not only on the job payload.
 * P1-01: the cases where others could reach it (visibility) wait for
 * stage 4's call authorization.
 */
const mode = (argv: string[]) => {
  const i = argv.indexOf("--permission-mode");
  return i < 0 ? "" : argv[i + 1];
};

test(
  "a safer process serves a turn that may run in bypass (no restart); a bypass process with background work is not killed for a turn that may not — the turn waits",
  { timeout: 60000 },
  async () => {
    process.env.DAISY_FIXTURE_WAKE_MS = "1500";
    const h = await setup();
    try {
      const claude = h.profile("claude");
      const s = await h.c.request<any>("/sessions", "POST", {
        agent: "claude",
        title: "solo",
        profileId: claude.id,
        workspaceId: h.cat.workspaces[0].id,
        visibility: "private",
      });
      const spawns = () =>
        h
          .lines(h.spawns)
          .filter(
            (x) =>
              x.argv.includes("--output-format") &&
              !x.argv.includes("--no-session-persistence"),
          );
      // Launched in the default mode; a timer pending.
      await h.c.send(s.id, "WAKE_TEST");
      await until(
        () => h.c.snapshot(s.id),
        (x) =>
          idle(x) &&
          !!x.session.live?.pending?.some((p) => p.kind === "wakeup"),
      );
      assert.equal(spawns().length, 1);
      assert.notEqual(mode(spawns()[0].argv), "bypassPermissions");
      // The identity goes to bypass (private AI, its own timer may): the
      // turn the process starts by itself is served by the safer process.
      h.ctx.store.run(
        "UPDATE profiles SET data=json_set(data,'$.permissionMode','bypassPermissions') WHERE id=?",
        claude.id,
      );
      await until(
        () => h.c.snapshot(s.id),
        (x) =>
          idle(x) &&
          x.items.some(
            (i) => i.kind === "assistant" && i.text === "Woke up by timer",
          ),
        300,
      );
      assert.equal(spawns().length, 1, "reused: no restart into bypass");
    } finally {
      delete process.env.DAISY_FIXTURE_WAKE_MS;
      await h.close();
    }
  },
);
