import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contextPlan,
  gateAfterSend,
  gateAfterSnapshot,
  gateOnContextKey,
  initialContextGate,
  latestContextKey,
  type ContextGate,
} from "../packages/ui/src/context.ts";
import type { Item, MessageContext } from "../packages/contracts/src/index.ts";

const ctx = (key: string): MessageContext => ({
  key,
  label: `页面 ${key}`,
  text: `正文 ${key}`,
  refs: [],
});
const user = (id: string, key?: string, status = "accepted"): Item => ({
  id,
  kind: "user",
  text: id,
  status,
  ...(key ? { context: ctx(key) } : {}),
  createdAt: 0,
});

/**
 * Drives DaisyChat's gate the way ChatView does: plan → send → Daisy
 * echoes the item in the next snapshot.
 */
function conversation() {
  let gate: ContextGate = initialContextGate;
  const items: Item[] = [];
  let n = 0;
  return {
    get gate() {
      return gate;
    },
    items,
    plan: (c: MessageContext | null, draft = "hi") =>
      contextPlan(c, items, gate, draft),
    send(c: MessageContext | null, draft = "hi", via = "user") {
      const p = contextPlan(c, items, gate, draft);
      const itemId = `${via}:${++n}`;
      gate = gateAfterSend(gate, {
        carried: p.attach,
        itemId,
        command: p.command,
      });
      return { carried: p.attach, itemId };
    },
    snapshot(item: Item) {
      items.push(item);
      gate = gateAfterSnapshot(gate, items);
    },
    skip(c: MessageContext) {
      gate = { ...gate, skipKey: c.key };
    },
    restore() {
      gate = { ...gate, skipKey: null };
    },
    page(c: MessageContext | null) {
      gate = gateOnContextKey(gate, c?.key ?? null);
    },
  };
}

test("latestContextKey: newest user item with a context; cancelled / failed do not count", () => {
  assert.equal(latestContextKey([]), null);
  assert.equal(latestContextKey([user("user:1")]), null);
  assert.equal(
    latestContextKey([
      user("user:1", "A"),
      user("user:2"),
      user("input:3", "B"),
    ]),
    "B",
  );
  assert.equal(
    latestContextKey([user("user:1", "A"), user("user:2", "B", "cancelled")]),
    "A",
  );
  assert.equal(
    latestContextKey([user("user:1", "A"), user("input:2", "B", "error")]),
    "A",
  );
  assert.equal(latestContextKey([user("user:1", "A", "queued")]), "A");
});

test("same key is not re-sent; a new key is sent; going back to an old key re-sends it", () => {
  const c = conversation();
  const A = ctx("A"),
    B = ctx("B");
  assert.equal(c.plan(A).attach, A);
  const first = c.send(A);
  assert.equal(first.carried, A);
  // Accepted but not in the snapshot yet: already counts as attached.
  assert.equal(c.plan(A).attached, true);
  assert.equal(c.plan(A).attach, null);
  c.snapshot(user(first.itemId, "A"));
  assert.equal(c.gate.sent, null);
  // Same page, next message: not re-sent.
  assert.equal(c.send(A).carried, null);
  c.snapshot(user("user:x"));
  assert.equal(c.plan(A).attached, true);
  // Page changed: the new context goes with the next message.
  c.page(B);
  assert.equal(c.plan(B).attached, false);
  const second = c.send(B);
  assert.equal(second.carried, B);
  c.snapshot(user(second.itemId, "B"));
  assert.equal(c.plan(B).attach, null);
  // Back to A: the latest context is B, so A is sent again.
  c.page(A);
  assert.equal(c.plan(A).attach, A);
  // No context at all: nothing attached, no bar state.
  assert.deepEqual(c.plan(null), {
    attached: false,
    skipped: false,
    command: false,
    attach: null,
  });
});

test("× skips exactly one message; restore undoes it; a new page clears it", () => {
  const c = conversation();
  const A = ctx("A"),
    B = ctx("B");
  c.skip(A);
  assert.equal(c.plan(A).skipped, true);
  assert.equal(c.plan(A).attach, null);
  const skipped = c.send(A);
  assert.equal(skipped.carried, null);
  c.snapshot(user(skipped.itemId));
  // Only that one message: the next one carries A.
  assert.equal(c.plan(A).skipped, false);
  assert.equal(c.plan(A).attach, A);
  // Restore before sending.
  c.skip(A);
  c.restore();
  assert.equal(c.plan(A).attach, A);
  // A skip for A does not survive switching to B (or back).
  c.skip(A);
  c.page(B);
  assert.equal(c.gate.skipKey, null);
  assert.equal(c.plan(B).attach, B);
  // Same key re-announced (e.g. re-render): the skip stays.
  c.skip(B);
  c.page(B);
  assert.equal(c.plan(B).skipped, true);
});

test("/ commands never carry the context and do not consume a skip", () => {
  const c = conversation();
  const A = ctx("A");
  const p = c.plan(A, "/compact");
  assert.equal(p.command, true);
  assert.equal(p.attach, null);
  c.skip(A);
  const cmd = c.send(A, "/fixture-skill go");
  assert.equal(cmd.carried, null);
  assert.equal(
    c.plan(A).skipped,
    true,
    "skip still applies to the next real message",
  );
  c.send(A);
  assert.equal(c.plan(A).attach, A);
});

test("cancelled / failed messages do not count as attached; steer items count", () => {
  const c = conversation();
  const A = ctx("A");
  const queued = c.send(A);
  c.snapshot(user(queued.itemId, "A", "queued"));
  assert.equal(c.plan(A).attached, true);
  // The queued message was removed before running: the Agent never saw A.
  c.items[c.items.length - 1] = user(queued.itemId, "A", "cancelled");
  assert.equal(c.plan(A).attached, false);
  assert.equal(c.plan(A).attach, A);
  // Sent as a live (steer) input: the item id is input:<id>.
  const live = c.send(A, "now", "input");
  assert.equal(live.itemId.startsWith("input:"), true);
  assert.equal(c.plan(A).attached, true);
  c.snapshot(user(live.itemId, "A", "error"));
  // The live input failed to reach the Agent: attach again.
  assert.equal(c.gate.sent, null);
  assert.equal(c.plan(A).attach, A);
});
