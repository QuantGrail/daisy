// P1-01: the call chain's depth and call budget, taken out of the chat's
// collaboration.ts (trackLineage, the retry check) for stage 4's A2A call
// chains: at most 8 levels deep, at most 64 calls per chain, retries count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/daisy/src/store/index.ts";
import {
  CHAIN_LIMITS,
  ChainLimitError,
  callChain,
} from "../packages/daisy/src/sessions/call-chain.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-chain-"));
  const store = new Store(dir);
  return {
    store,
    chain: callChain(store),
    done: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("the limits are the chat's: depth 8, 64 calls", () => {
  assert.deepEqual({ ...CHAIN_LIMITS }, { depth: 8, calls: 64 });
});

test("depth: a call caused by a call goes one level deeper; the 9th level is refused", () => {
  const { chain, store, done } = fixture();
  try {
    assert.deepEqual(chain.track({ id: "c1", root: "job:j1" }), {
      root: "job:j1",
      depth: 1,
    });
    let parent = "c1";
    for (let d = 2; d <= 8; d++) {
      const link = chain.track({ id: `c${d}`, parent });
      assert.deepEqual(link, { root: "job:j1", depth: d });
      parent = `c${d}`;
    }
    assert.throws(
      () => chain.track({ id: "c9", parent }),
      (e: any) =>
        e instanceof ChainLimitError &&
        e.statusCode === 429 &&
        e.apiCode === "chain_depth" &&
        /调用链已达 8 层/.test(e.message),
    );
    // Nothing of the refused call was recorded.
    assert.equal(chain.of("c9"), null);
    assert.equal(chain.used("job:j1"), 8);
    // A step that is no call (calls 0) hangs on the chain without a level.
    assert.deepEqual(chain.track({ id: "note", parent, calls: 0 }), {
      root: "job:j1",
      depth: 8,
    });
    assert.equal(chain.used("job:j1"), 8);
    assert.ok(store.one("SELECT 1 FROM call_lineage WHERE call_id='note'"));
  } finally {
    done();
  }
});

test("budget: 64 calls per chain, a fresh chain has its own; no parent, no root → its own root", () => {
  const { chain, done } = fixture();
  try {
    for (let i = 0; i < 64; i++) chain.track({ id: `a${i}`, root: "job:a" });
    assert.equal(chain.used("job:a"), 64);
    assert.throws(
      () => chain.track({ id: "a64", root: "job:a" }),
      (e: any) =>
        e.apiCode === "chain_calls" && /已达 64 次调用/.test(e.message),
    );
    // Charging several at once is checked as a whole.
    chain.track({ id: "b0", root: "job:b", calls: 60 });
    assert.throws(() => chain.track({ id: "b1", root: "job:b", calls: 5 }));
    chain.track({ id: "b2", root: "job:b", calls: 4 });
    assert.equal(chain.used("job:b"), 64);
    // Its own root.
    assert.deepEqual(chain.track({ id: "solo" }), { root: "solo", depth: 1 });
    // An unknown parent starts from `root` (or itself).
    assert.deepEqual(chain.track({ id: "x", parent: "nope", root: "job:x" }), {
      root: "job:x",
      depth: 1,
    });
  } finally {
    done();
  }
});

test("retry: one more call on the chain, refused once it has used its budget", () => {
  const { chain, done } = fixture();
  try {
    chain.track({ id: "r0", root: "job:r", calls: 63 });
    assert.deepEqual(chain.retry("r0"), { root: "job:r", depth: 1 });
    assert.equal(chain.used("job:r"), 64);
    assert.throws(
      () => chain.retry("r0"),
      (e: any) =>
        e.apiCode === "chain_calls" && /请由本人重新发起任务/.test(e.message),
    );
    // An untracked call is not charged.
    assert.equal(chain.retry("never"), null);
  } finally {
    done();
  }
});

test("custom limits (stage 4 may tune them per contract)", () => {
  const { store, done } = fixture();
  try {
    const c = callChain(store, { depth: 2, calls: 3 });
    c.track({ id: "1", root: "r" });
    c.track({ id: "2", parent: "1" });
    assert.throws(() => c.track({ id: "3", parent: "2" }), /2 层/);
    c.track({ id: "4", parent: "1" });
    assert.throws(() => c.track({ id: "5", parent: "1" }), /3 次调用/);
  } finally {
    done();
  }
});
