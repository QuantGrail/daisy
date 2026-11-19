/**
 * P1-05: the PIN (5.11 「PIN 码」, D-11, D-32, D-36, ADR-099, limits.md
 * §6, local-api.md §6). Refusals first: no PIN → no grant and no AI turn;
 * a wrong PIN is refused and counted (before it is hashed); the 5th locks,
 * and while locked even the right PIN is refused — across a restart, and a
 * clock that jumped cannot stretch it; a grant dies when it expires, when
 * the PIN changes and on a local reset (which runs the reset hooks), and
 * serves only the credential that bought it; the PIN's length rule; a
 * verifier out of shape fails closed; neither the PIN nor a grant is in
 * the database, the audit, an error or the logs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, hash } from "../packages/daisy/src/store/index.ts";
import { createHash } from "node:crypto";
import { readFileSync as readCli } from "node:fs";
import { openDatabase, STORAGE } from "../packages/daisy/src/store/open.ts";
import { MIGRATIONS } from "../packages/daisy/src/store/schema.ts";
import { createApp } from "../packages/daisy/src/app.ts";
import {
  createPinService,
  PinError,
  PIN_GRANT_HEADER,
  type PinService,
} from "../packages/daisy/src/access/pin.ts";
import {
  API_ROUTES,
  PIN_LIMITS,
  pinLockMs,
} from "../packages/contracts/src/index.ts";
import { runnerHeaders, runnerInject } from "./fixtures/runner-calls.ts";

const MIN = 60_000;
const YEAR = 365 * 24 * 60 * MIN;
// Tests hash with a small scrypt cost (the verifier records its own); one
// test below checks the real default (2^17, 8, 1).
const CHEAP = { log2N: 10, r: 8, p: 1 };
const PIN = "246813",
  PIN2 = "correct horse 电池 staple";
/** The credential a grant is bound to (local-api.md §6.3). */
const H = "bearer:holder-1";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "daisy-pin-"));
  let t = 1_800_000_000_000;
  const clock = {
    now: () => t,
    advance: (ms: number) => (t += ms),
    set: (ms: number) => (t = ms),
  };
  let store = new Store(dir);
  const make = () => createPinService(store, { now: clock.now, scrypt: CHEAP });
  return {
    dir,
    clock,
    get store() {
      return store;
    },
    pin: make(),
    /** Close the database and open it again: a new process. */
    restart(): PinService {
      store.close();
      store = new Store(dir);
      return make();
    },
    done() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
/** The PinError `fn` throws (fails when it throws nothing or something else). */
function refusal(fn: () => unknown): PinError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PinError, `not a PinError: ${e}`);
    return e;
  }
  assert.fail("expected a refusal");
}
const pinRow = (store: Store) =>
  store.one(
    "SELECT verifier,failures,rounds,locked_at,locked_until FROM pin WHERE id=1",
  );
/** A grant-less wrong entry `n` times. */
const wrong = (pin: PinService, n: number) => {
  let e: PinError | undefined;
  for (let i = 0; i < n; i++) e = refusal(() => pin.grant("000000", H));
  return e!;
};

test("schema step 2 (P1-04's MIGRATIONS) adds the PIN's tables to a version-1 database, nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-pin-v1-"));
  try {
    assert.equal(MIGRATIONS[1]!.version, 2);
    assert.match(MIGRATIONS[1]!.sql, /CREATE TABLE pin\(/);
    assert.equal(MIGRATIONS[1]!.breaking, undefined);
    // A database at step 1 (the frozen structure), then today's code.
    const v1 = openDatabase(dir, { migrations: MIGRATIONS.slice(0, 1) });
    const before = v1.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    assert.ok(!before.includes("pin"));
    v1.db.close();
    // Step 2 alone (P1-11's step 3 has its own test, tests/audit.test.ts).
    const v2 = openDatabase(dir, { migrations: MIGRATIONS.slice(0, 2) });
    const after = v2.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    assert.deepEqual(after.filter((n: string) => !before.includes(n)), ["pin", "pin_grants"]);
    assert.equal(Number((v2.db.prepare("PRAGMA user_version").get() as any).user_version), 2);
    v2.db.close();
    const store = new Store(dir);
    const pin = createPinService(store, { scrypt: CHEAP });
    pin.set(PIN);
    assert.ok(pin.check(pin.grant(PIN, H).grant, H));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no PIN set: a grant is refused, nothing is counted, no check passes", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.pin.status(), {
      set: false,
      lockedUntil: null,
      setAt: null,
      setVia: null,
      resetAt: null,
      resetVia: null,
    });
    const e = refusal(() => f.pin.grant(PIN, H));
    assert.equal(e.code, "pin_not_set");
    assert.equal(e.statusCode, 409);
    assert.match(e.message, /还没有设置 PIN.*先设置 PIN：daisy pin set/);
    assert.equal(pinRow(f.store), undefined, "nothing written");
    for (const g of [undefined, "", "x", "A".repeat(43), "A".repeat(1000)])
      assert.equal(f.pin.check(g, H), false);
  } finally {
    f.done();
  }
});

test("length rule: at least 6, at most 128, digits only allowed, no control characters; NFKC", () => {
  const f = fixture();
  try {
    for (const bad of ["", "12345", "abcde", "x".repeat(129), "123456\n", "12\t3456"]) {
      const e = refusal(() => f.pin.set(bad));
      assert.equal(e.code, "pin_invalid", JSON.stringify(bad));
      assert.equal(e.statusCode, 400);
      assert.equal(f.pin.status().set, false);
    }
    assert.match(refusal(() => f.pin.set("12345")).message, /6 到 128 位/);
    // Six code points of a non-BMP script count as six, not twelve.
    assert.equal(refusal(() => f.pin.set("𠀀𠀀𠀀𠀀𠀀")).code, "pin_invalid");
    for (const ok of ["000000", "x".repeat(128), "𠀀𠀀𠀀𠀀𠀀𠀀", PIN2]) {
      const g = fixture();
      try {
        g.pin.set(ok);
        assert.ok(g.pin.check(g.pin.grant(ok, H).grant, H), JSON.stringify(ok));
      } finally {
        g.done();
      }
    }
    // NFKC: full-width digits are the ASCII ones; a decomposed é is é.
    const fullWidth = String.fromCharCode(...[..."135790"].map((d) => 0xff10 + +d));
    f.pin.set(fullWidth);
    assert.ok(f.pin.grant("135790", H).grant);
    const g = fixture();
    try {
      g.pin.set("caf" + String.fromCharCode(0xe9) + "-1234");
      assert.ok(g.pin.grant("cafe" + String.fromCharCode(0x301) + "-1234", H).grant);
    } finally {
      g.done();
    }
  } finally {
    f.done();
  }
});

test("a wrong PIN is refused and counted; a right one clears the count", () => {
  const f = fixture();
  try {
    f.pin.set(PIN);
    for (let i = 1; i < PIN_LIMITS.attemptsPerRound; i++) {
      const e = refusal(() => f.pin.grant("135792", H));
      assert.equal(e.code, "pin_wrong");
      assert.equal(e.statusCode, 403);
      assert.match(e.message, new RegExp(`再输错 ${PIN_LIMITS.attemptsPerRound - i} 次`));
      assert.equal(pinRow(f.store).failures, i);
      assert.equal(f.pin.status().lockedUntil, null);
    }
    f.pin.grant(PIN, H);
    assert.equal(pinRow(f.store).failures, 0);
    // Outside the length rule: still a wrong PIN, still counted.
    assert.equal(refusal(() => f.pin.grant("1", H)).code, "pin_wrong");
    assert.equal(pinRow(f.store).failures, 1);
  } finally {
    f.done();
  }
});

test("an entry is counted before it is hashed: a crash before the right PIN clears the count keeps it", () => {
  const f = fixture();
  try {
    f.pin.set(PIN);
    // The service's second transaction (clearing after a right PIN) dies,
    // as if the process crashed while / right after hashing.
    let calls = 0;
    const crashing: any = {
      one: (...a: any[]) => (f.store.one as any)(...a),
      all: (...a: any[]) => (f.store.all as any)(...a),
      run: (...a: any[]) => (f.store.run as any)(...a),
      atomic: (fn: () => unknown) => {
        if (++calls === 2) throw new Error("crash");
        return f.store.atomic(fn);
      },
    };
    const pin = createPinService(crashing, { now: f.clock.now, scrypt: CHEAP });
    assert.throws(() => pin.grant(PIN, H), /crash/);
    assert.equal(pinRow(f.store).failures, 1, "the entry stayed counted");
    // At the limit the reservation itself locks; only a right PIN undoes it.
    wrong(f.pin, 3);
    calls = 0;
    assert.throws(() => pin.grant(PIN, H), /crash/);
    assert.ok(f.pin.status().lockedUntil, "the 5th entry locked before hashing");
    // Once the lock is over, the right PIN clears everything.
    f.clock.advance(15 * MIN);
    f.pin.grant(PIN, H);
    assert.deepEqual(
      { ...pinRow(f.store), verifier: undefined },
      { verifier: undefined, failures: 0, rounds: 0, locked_at: 0, locked_until: 0 },
    );
  } finally {
    f.done();
  }
});

test("the 5th wrong PIN locks: the right PIN is refused while locked, the lock survives a restart, then lifts", () => {
  const f = fixture();
  try {
    f.pin.set(PIN);
    wrong(f.pin, PIN_LIMITS.attemptsPerRound - 1);
    const fifth = refusal(() => f.pin.grant("000000", H));
    assert.equal(fifth.code, "pin_locked");
    assert.equal(fifth.statusCode, 423);
    assert.equal(fifth.justLocked, true);
    assert.equal(fifth.retryAfter, 15 * 60);
    assert.match(fifth.message, /连续输错 5 次，已锁定：约 15 分钟后再试/);
    const until = f.clock.now() + 15 * MIN;
    assert.equal(f.pin.status().lockedUntil, until);
    // Locked: the right PIN is refused, and so is a change with it.
    const locked = refusal(() => f.pin.grant(PIN, H));
    assert.equal(locked.code, "pin_locked");
    assert.equal(locked.justLocked, false);
    assert.equal(refusal(() => f.pin.set("999999", PIN)).code, "pin_locked");
    // A restart (new store, new service) keeps the lock.
    const after = f.restart();
    assert.equal(after.status().lockedUntil, until);
    f.clock.advance(15 * MIN - 1000);
    const still = refusal(() => after.grant(PIN, H));
    assert.equal(still.code, "pin_locked");
    assert.equal(still.retryAfter, 1);
    // Lifted: the right PIN works and clears the rounds.
    f.clock.advance(1000);
    assert.equal(after.status().lockedUntil, null);
    assert.ok(after.check(after.grant(PIN, H).grant, H));
    assert.deepEqual(
      { ...pinRow(f.store), verifier: undefined },
      { verifier: undefined, failures: 0, rounds: 0, locked_at: 0, locked_until: 0 },
    );
  } finally {
    f.done();
  }
});

test("a clock that jumped cannot stretch a lock: at most one lock long from now", () => {
  const f = fixture();
  try {
    f.pin.set(PIN);
    const T = f.clock.now();
    // Locked while the clock was 5 years ahead, then the clock is corrected.
    f.clock.set(T + 5 * YEAR);
    wrong(f.pin, PIN_LIMITS.attemptsPerRound);
    assert.equal(f.pin.status().lockedUntil, T + 5 * YEAR + 15 * MIN);
    f.clock.set(T);
    assert.equal(f.pin.status().lockedUntil, T + 15 * MIN, "recomputed from now");
    assert.equal(pinRow(f.store).locked_until, T + 15 * MIN, "and written back");
    assert.equal(pinRow(f.store).locked_at, T);
    f.clock.advance(15 * MIN);
    assert.ok(f.pin.grant(PIN, H).grant);
    // A lock that ends further away than its round's length (row edited,
    // or a clock that ran back after locking) is cut to one lock from now.
    wrong(f.pin, PIN_LIMITS.attemptsPerRound);
    f.store.run("UPDATE pin SET locked_until=? WHERE id=1", f.clock.now() + 10 * YEAR);
    assert.equal(f.pin.status().lockedUntil, f.clock.now() + 15 * MIN);
    // A future start is pulled back too (round 2 here: one hour).
    f.clock.advance(15 * MIN);
    wrong(f.pin, PIN_LIMITS.attemptsPerRound);
    f.store.run("UPDATE pin SET locked_at=? WHERE id=1", f.clock.now() + YEAR);
    assert.equal(f.pin.status().lockedUntil, f.clock.now() + 60 * MIN);
  } finally {
    f.done();
  }
});

test("locks lengthen round by round (15 min, 1 h, 2 h, … ≤ 24 h); a right PIN starts over", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 50].map(pinLockMs),
    [15, 60, 120, 240, 480, 960, 1440, 1440, 1440].map((m) => m * MIN),
  );
  const f = fixture();
  try {
    f.pin.set(PIN);
    const round = () => {
      assert.equal(wrong(f.pin, PIN_LIMITS.attemptsPerRound).code, "pin_locked");
      const ms = f.pin.status().lockedUntil! - f.clock.now();
      f.clock.advance(ms);
      return ms;
    };
    assert.equal(round(), 15 * MIN);
    assert.equal(round(), 60 * MIN);
    assert.equal(round(), 120 * MIN);
    f.pin.grant(PIN, H);
    assert.equal(round(), 15 * MIN);
  } finally {
    f.done();
  }
});

test("a grant: valid until it expires (5 min), only for the credential that bought it; a forged or altered one fails", () => {
  const f = fixture();
  try {
    f.pin.set(PIN);
    // A grant always has a holder.
    assert.throws(() => f.pin.grant(PIN, undefined as any), /holder/);
    assert.throws(() => f.pin.grant(PIN, ""), /holder/);
    const { grant, expiresAt } = f.pin.grant(PIN, H);
    assert.equal(expiresAt, f.clock.now() + PIN_LIMITS.grantTtlMs);
    assert.equal(PIN_LIMITS.grantTtlMs, 5 * MIN);
    assert.match(grant, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
    assert.ok(f.pin.check(grant, H));
    // Another credential, or none, cannot use it.
    assert.equal(f.pin.check(grant, "bearer:someone-else"), false);
    assert.equal(f.pin.check(grant, undefined), false);
    assert.equal(f.pin.check(grant, ""), false);
    const flipped = (grant[0] === "A" ? "B" : "A") + grant.slice(1);
    assert.equal(f.pin.check(flipped, H), false);
    assert.equal(f.pin.check(grant + "=", H), false);
    assert.equal(f.pin.check(grant.slice(1), H), false);
    assert.notEqual(f.pin.grant(PIN, H).grant, grant, "each grant is new");
    // A row without a holder (written by hand) is never a grant.
    assert.throws(() =>
      f.store.run(
        "INSERT INTO pin_grants(hash,holder,expires,created) VALUES('x',NULL,?,0)",
        f.clock.now() + MIN,
      ),
    );
    // Expiry.
    f.clock.advance(PIN_LIMITS.grantTtlMs - 1);
    assert.ok(f.pin.check(grant, H));
    f.clock.advance(1);
    assert.equal(f.pin.check(grant, H), false);
    // A restart keeps a live grant (it is in the database, hashed).
    const g2 = f.pin.grant(PIN, H).grant;
    assert.ok(f.restart().check(g2, H));
  } finally {
    f.done();
  }
});

test("consume: a grant used once is spent (the command line, local-api.md §6.5); another holder cannot spend it", () => {
  const f = fixture();
  try {
    f.pin.set(PIN);
    const g = f.pin.grant(PIN, H).grant;
    // Another credential: refused, and the grant is not spent.
    assert.equal(f.pin.consume(g, "bearer:someone-else"), false);
    assert.equal(f.pin.consume(g, undefined), false);
    assert.ok(f.pin.check(g, H), "still live for its holder");
    // Its holder spends it: true once, then gone for check and consume alike.
    assert.equal(f.pin.consume(g, H), true);
    assert.equal(f.pin.check(g, H), false);
    assert.equal(f.pin.consume(g, H), false);
    // Spending one leaves the holder's other grants alone.
    const a = f.pin.grant(PIN, H).grant,
      b = f.pin.grant(PIN, H).grant;
    assert.ok(f.pin.consume(a, H));
    assert.ok(f.pin.check(b, H));
    // Expired or forged: false.
    f.clock.advance(PIN_LIMITS.grantTtlMs);
    assert.equal(f.pin.consume(b, H), false);
    assert.equal(f.pin.consume("x", H), false);
  } finally {
    f.done();
  }
});

test("changing the PIN needs the old one (counted when wrong) and ends every grant; status says when and how", () => {
  const f = fixture();
  try {
    f.pin.set(PIN, undefined, "cli");
    const t0 = f.clock.now();
    assert.deepEqual(f.pin.status(), {
      set: true,
      lockedUntil: null,
      setAt: t0,
      setVia: "cli",
      resetAt: null,
      resetVia: null,
    });
    const old = f.pin.grant(PIN, H).grant;
    const missing = refusal(() => f.pin.set(PIN2));
    assert.equal(missing.code, "pin_old_required");
    const bad = refusal(() => f.pin.set(PIN2, "999999"));
    assert.equal(bad.code, "pin_wrong");
    assert.equal(pinRow(f.store).failures, 1);
    assert.equal(refusal(() => f.pin.set("12345", PIN)).code, "pin_invalid");
    assert.ok(f.pin.check(old, H), "refusals change nothing");
    f.clock.advance(MIN);
    f.pin.set(PIN2, PIN, "web");
    assert.equal(f.pin.status().setAt, t0 + MIN);
    assert.equal(f.pin.status().setVia, "web");
    assert.equal(f.pin.check(old, H), false, "the old PIN's grant is gone");
    assert.equal(refusal(() => f.pin.grant(PIN, H)).code, "pin_wrong");
    assert.ok(f.pin.check(f.pin.grant(PIN2, H).grant, H));
    assert.equal(pinRow(f.store).failures, 0);
  } finally {
    f.done();
  }
});

test("resetLocal: the PIN and every grant go, the reset hooks run, status says when and how; a failing hook undoes the reset", () => {
  const f = fixture();
  try {
    f.pin.set(PIN, undefined, "cli");
    const setAt = f.clock.now();
    const g = f.pin.grant(PIN, H).grant;
    const other = f.pin.grant(PIN, "device:1").grant;
    // A failing hook (stage 4: revoking something did not work): nothing is reset.
    const calls: string[] = [];
    f.pin.onReset(() => calls.push("first"));
    let fail = true;
    f.pin.onReset(() => {
      calls.push("second");
      if (fail) throw new Error("could not revoke");
    });
    assert.throws(() => f.pin.resetLocal(), /could not revoke/);
    assert.ok(f.pin.status().set);
    assert.equal(f.pin.status().resetAt, null);
    assert.ok(f.pin.check(g, H));
    fail = false;
    calls.length = 0;
    f.clock.advance(MIN);
    f.pin.resetLocal("cli");
    assert.deepEqual(calls, ["first", "second"]);
    assert.deepEqual(f.pin.status(), {
      set: false,
      lockedUntil: null,
      setAt,
      setVia: "cli",
      resetAt: setAt + MIN,
      resetVia: "cli",
    });
    assert.equal(f.pin.check(g, H), false);
    assert.equal(f.pin.check(other, "device:1"), false);
    assert.equal(refusal(() => f.pin.grant(PIN, H)).code, "pin_not_set");
    // A reset also clears a lock; a new PIN is set without the old one.
    f.pin.set(PIN);
    wrong(f.pin, PIN_LIMITS.attemptsPerRound);
    assert.ok(f.pin.status().lockedUntil);
    f.pin.resetLocal();
    assert.equal(f.pin.status().resetVia, "local", "an in-process reset");
    f.pin.set(PIN2);
    assert.ok(f.pin.check(f.pin.grant(PIN2, H).grant, H));
    assert.equal(f.store.one("SELECT count(*) n FROM pin_grants").n, 1);
  } finally {
    f.done();
  }
});

test("a verifier out of shape fails closed: lengths, bounds, the normalization mark", () => {
  const f = fixture();
  try {
    f.pin.set(PIN);
    const good: string = pinRow(f.store).verifier;
    assert.match(good, /^scrypt\$norm=nfkc,ln=10,r=8,p=1\$/);
    const [, , salt, key] = good.split("$");
    const B = (n: number) => Buffer.alloc(n, 7).toString("base64url");
    for (const bad of [
      `scrypt$ln=10,r=8,p=1$${salt}$${key}`, // no normalization mark (old form)
      `scrypt$norm=nfc,ln=10,r=8,p=1$${salt}$${key}`,
      `scrypt$norm=nfkc,ln=21,r=8,p=1$${salt}$${key}`, // N too large
      `scrypt$norm=nfkc,ln=9,r=8,p=1$${salt}$${key}`,
      `scrypt$norm=nfkc,ln=10,r=33,p=1$${salt}$${key}`,
      `scrypt$norm=nfkc,ln=10,r=8,p=17$${salt}$${key}`,
      `scrypt$norm=nfkc,ln=10,r=0,p=1$${salt}$${key}`,
      `scrypt$norm=nfkc,ln=10,r=8,p=1$${B(15)}$${key}`, // salt ≠ 16 bytes
      `scrypt$norm=nfkc,ln=10,r=8,p=1$${B(17)}$${key}`,
      `scrypt$norm=nfkc,ln=10,r=8,p=1$${salt}$${B(31)}`, // key ≠ 32 bytes
      `scrypt$norm=nfkc,ln=10,r=8,p=1$${salt}$${B(33)}`,
      "plain:246813",
    ]) {
      f.store.run("UPDATE pin SET verifier=?,failures=0 WHERE id=1", bad);
      const e = refusal(() => f.pin.grant(PIN, H));
      assert.equal(e.code, "pin_verifier_unreadable", bad);
      assert.ok(!e.message.includes(PIN));
      assert.equal(pinRow(f.store).failures, 0, "not counted, not hashed");
    }
    // The good one still works (the test's bounds are not too tight).
    f.store.run("UPDATE pin SET verifier=? WHERE id=1", good);
    assert.ok(f.pin.grant(PIN, H).grant);
  } finally {
    f.done();
  }
});

test("only a verifier is stored: scrypt 2^17/8/1, its parameters with it; no PIN or grant anywhere in the database files", () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-pin-db-"));
  const store = new Store(dir);
  try {
    const pin = createPinService(store); // the real default cost
    const t0 = Date.now();
    pin.set(PIN2);
    const ms = Date.now() - t0;
    const { grant } = pin.grant(PIN2, H);
    const v: string = pinRow(store).verifier;
    assert.match(v, /^scrypt\$norm=nfkc,ln=17,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    assert.ok(ms >= 20, `scrypt at 2^17 should cost real time (took ${ms} ms)`);
    // Two verifiers of one PIN differ (random salt).
    const other = mkdtempSync(join(tmpdir(), "daisy-pin-db2-"));
    const s2 = new Store(other);
    createPinService(s2, { scrypt: CHEAP }).set(PIN2);
    const weak: string = pinRow(s2).verifier;
    assert.notEqual(weak.split("$")[2], v.split("$")[2]);
    s2.close();
    rmSync(other, { recursive: true, force: true });
    // Every table, every text column: no PIN, no grant.
    const needles = [PIN2, grant, Buffer.from(PIN2).toString("base64"), Buffer.from(PIN2).toString("hex")];
    for (const { name } of store.all("SELECT name FROM sqlite_master WHERE type='table'"))
      for (const row of store.all(`SELECT * FROM ${name}`))
        for (const n of needles)
          assert.ok(!JSON.stringify(row).includes(n), `${name} holds a secret`);
    // And the bytes on disk (database, WAL).
    store.db.exec("PRAGMA wal_checkpoint(FULL)");
    const files = readdirSync(dir).filter((x) => x.startsWith(STORAGE.file));
    assert.ok(files.length >= 1, "the database files are scanned");
    for (const file of files) {
      const bytes = readFileSync(join(dir, file));
      for (const n of [PIN2, grant])
        assert.equal(bytes.indexOf(Buffer.from(n)), -1, `${file} holds a secret`);
    }
    // A verifier made weaker than today's setting is upgraded on the next right entry.
    store.run("UPDATE pin SET verifier=? WHERE id=1", weak);
    pin.grant(PIN2, H);
    assert.match(pinRow(store).verifier, /^scrypt\$norm=nfkc,ln=17,r=8,p=1\$/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no PIN, no AI turn — a message is refused, queued work is not claimed, an online process may not start a turn; set → runs; reset → a running turn goes on, no new one starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-pin-d36-"));
  // The gate is on by default (pinGate is not passed).
  const { app, store, issueToken, runnerApi, pin } = await createApp({
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
  });
  const inject = runnerInject(app, runnerApi);
  try {
    const headers = { authorization: `Bearer ${issueToken()}` };
    const nh = runnerHeaders(JSON.parse(readFileSync(join(dir, "runner.json"), "utf8")).nodeId);
    const call = (method: any, url: string, payload?: any, h: any = headers) =>
      inject({ method, url, payload, headers: h });
    const c = (await call("GET", "/api/catalog")).json();
    const s = (
      await call("POST", "/api/sessions", {
        title: "D-36",
        agent: "claude",
        workspaceId: c.workspaces[0].id,
        profileId: c.profiles.find((p: any) => p.agent === "claude").id,
      })
    ).json();
    const s2 = (
      await call("POST", "/api/sessions", {
        title: "D-36 other",
        agent: "claude",
        workspaceId: c.workspaces[0].id,
        profileId: c.profiles.find((p: any) => p.agent === "claude").id,
      })
    ).json();
    const send = (requestId: string) =>
      call("POST", `/api/sessions/${s.id}/messages`, { requestId, text: "Hello" });
    // No PIN: the message is refused, saying what to do.
    const refused = await send("request-d36-0001");
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().code, "pin_not_set");
    assert.match(refused.json().error, /先设置 PIN：daisy pin set/);
    assert.equal(store.one("SELECT count(*) n FROM jobs WHERE session_id=?", s.id).n, 0);
    // Work that got queued anyway (a timer, a carried wake…) is not claimed:
    // no harness starts.
    store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created) VALUES(?,?,?,?,?,?,?,?)",
      "job-timer",
      s.id,
      store.session(s.id)!.nodeId,
      "timer-1",
      "timer",
      "[]",
      "queued",
      Date.now(),
    );
    const none = (await call("POST", "/api/runner/claim", {}, nh)).json();
    assert.equal(none.job, null);
    assert.equal(store.one("SELECT status FROM jobs WHERE id='job-timer'").status, "queued");
    // An online process starting a turn by itself is refused (the Runner ends it).
    const wake = await call("POST", `/api/runner/live/${s.id}/wake`, { reason: "timer" }, nh);
    assert.equal(wake.statusCode, 403);
    assert.equal(wake.json().code, "pin_not_set");
    // Set a PIN (the command line may): the queued work runs.
    assert.equal((await call("POST", "/api/pin", { pin: PIN })).statusCode, 200);
    const job = (await call("POST", "/api/runner/claim", {}, nh)).json().job;
    assert.equal(job.id, "job-timer");
    // Reset (in process, on this machine): the running turn goes on…
    pin.resetLocal("cli");
    const jh = { ...nh, "x-lease": job.lease };
    assert.equal((await call("POST", `/api/runner/jobs/${job.id}/pulse`, {}, jh)).statusCode, 200);
    assert.equal(store.one("SELECT status FROM jobs WHERE id='job-timer'").status, "running");
    // …but no new turn: a new message is refused, queued work waits.
    assert.equal((await send("request-d36-0002")).json().code, "pin_not_set");
    store.run(
      "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created) VALUES(?,?,?,?,?,?,?,?)",
      "job-after",
      s2.id,
      store.session(s2.id)!.nodeId,
      "timer-2",
      "timer",
      "[]",
      "queued",
      Date.now(),
    );
    assert.equal((await call("POST", "/api/runner/claim", {}, nh)).json().job, null);
    // The status the web page shows (D-36 notice).
    const st = (await call("GET", "/api/pin")).json();
    assert.equal(st.set, false);
    assert.equal(st.resetVia, "cli");
    assert.ok(st.resetAt > 0 && st.setAt > 0);
    assert.equal(st.setVia, "web", "P1-03: the channel the guard recognised");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routes: definitions (scope, channels, never the AI), status / set / grant over HTTP, a grant serves only its credential, reset refused off the local CLI", async () => {
  const byId = (id: string) => API_ROUTES.find((r) => r.id === id)!;
  assert.equal(PIN_GRANT_HEADER, "daisy-pin-grant");
  for (const [id, method, path, scope] of [
    ["settings.pinStatus", "GET", "/api/pin", "daisy:manage"],
    ["settings.pinSet", "POST", "/api/pin", "daisy:manage"],
    ["settings.pinGrant", "POST", "/api/pin/grant", "daisy:grant"],
    ["settings.pinReset", "POST", "/api/pin/reset", "daisy:grant"],
  ]) {
    const r = byId(id);
    assert.deepEqual([r.method, r.path, r.scope], [method, path, scope], id);
    assert.ok(!r.channels.includes("ai"), `${id} must not be open to the AI`);
    assert.equal(r.pin, false, `${id}: the PIN routes themselves need no grant`);
  }
  assert.deepEqual(byId("settings.pinReset").channels, ["cli"]);

  const dir = mkdtempSync(join(tmpdir(), "daisy-pin-http-"));
  const ctx = await createApp({ dataDir: dir, workspaceHome: dir, workspaceRoots: [dir], sharedHost: () => false });
  // Everything written to the console / stdout / stderr while the PIN is in use.
  const logged: string[] = [];
  const saved = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    out: process.stdout.write,
    err: process.stderr.write,
  };
  const keep = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  console.log = console.error = console.warn = console.info = keep;
  process.stdout.write = ((c: any, ...r: any[]) => (logged.push(String(c)), saved.out.call(process.stdout, c, ...r))) as any;
  process.stderr.write = ((c: any, ...r: any[]) => (logged.push(String(c)), saved.err.call(process.stderr, c, ...r))) as any;
  const bodies: string[] = [];
  try {
    // P1-03: two web sessions of the one owner (two credentials).
    const tokenA = ctx.issueToken(),
      tokenB = ctx.issueToken();
    const call = async (method: any, url: string, payload?: any, token = tokenA) => {
      const r = await ctx.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      bodies.push(r.body);
      return r;
    };
    // No credential: refused by the guard (P1-03).
    assert.equal((await ctx.app.inject({ url: "/api/pin" })).statusCode, 401);
    assert.equal((await call("GET", "/api/pin")).json().set, false);
    const notSet = await call("POST", "/api/pin/grant", { pin: PIN });
    assert.equal(notSet.statusCode, 409);
    assert.equal(notSet.json().code, "pin_not_set");
    const short = await call("POST", "/api/pin", { pin: "12345" });
    assert.equal(short.statusCode, 400);
    assert.equal(short.json().code, "pin_invalid");
    assert.equal((await call("POST", "/api/pin", { pin: PIN, extra: 1 })).statusCode, 400);
    assert.equal((await call("POST", "/api/pin", { pin: PIN })).statusCode, 200);
    const again = await call("POST", "/api/pin", { pin: PIN2 });
    assert.equal(again.json().code, "pin_old_required");
    // Wrong four times, then the fifth locks: 423 with Retry-After.
    for (let i = 0; i < 4; i++) {
      const w = await call("POST", "/api/pin/grant", { pin: "000000" });
      assert.equal(w.statusCode, 403);
      assert.equal(w.json().code, "pin_wrong");
    }
    const lock = await call("POST", "/api/pin/grant", { pin: "000000" });
    assert.equal(lock.statusCode, 423);
    assert.equal(lock.json().code, "pin_locked");
    assert.equal(lock.json().retryAfter, 900);
    assert.equal(lock.headers["retry-after"], "900");
    const right = await call("POST", "/api/pin/grant", { pin: PIN });
    assert.equal(right.statusCode, 423, "locked: the right PIN too");
    assert.ok((await call("GET", "/api/pin")).json().lockedUntil > Date.now());
    // Unlock (as after 15 minutes) and buy a grant with credential A.
    ctx.store.run("UPDATE pin SET locked_until=0 WHERE id=1");
    const ok = await call("POST", "/api/pin/grant", { pin: PIN });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers["cache-control"], "no-store");
    const { grant, expiresAt } = ok.json();
    assert.ok(expiresAt - Date.now() <= PIN_LIMITS.grantTtlMs);
    // Bound to the credential that bought it (P1-03 holderOf: the web
    // session's hash): another credential of the same owner cannot use it.
    const holder = ctx.store.one("SELECT holder FROM pin_grants").holder;
    assert.match(holder, /^web:[0-9a-f]{64}$/);
    assert.ok(!holder.includes(tokenA));
    assert.ok(ctx.pin.check(grant, holder));
    const holderB = `web:${createHash("sha256").update(tokenB).digest("hex")}`;
    assert.equal(ctx.pin.check(grant, holderB), false, "another credential");
    // Change it (the old PIN), then the old grant is gone.
    assert.equal((await call("POST", "/api/pin", { pin: PIN2, oldPin: PIN })).statusCode, 200);
    assert.equal(ctx.pin.check(grant, holder), false);
    const g2 = (await call("POST", "/api/pin/grant", { pin: PIN2 }, tokenB)).json().grant;
    assert.ok(ctx.pin.check(g2, holderB));
    assert.equal(ctx.pin.check(g2, holder), false);
    // Reset from the web page: refused by the guard (channels: cli only).
    const reset = await call("POST", "/api/pin/reset", { confirm: true });
    assert.equal(reset.statusCode, 403);
    assert.equal(reset.json().code, "channel_not_allowed");
    assert.ok(ctx.pin.status().set);
    assert.ok(ctx.pin.check(g2, holderB));
    // An unreadable verifier is refused and audited.
    const v = ctx.store.one("SELECT verifier FROM pin").verifier;
    ctx.store.run("UPDATE pin SET verifier='broken' WHERE id=1");
    const broken = await call("POST", "/api/pin/grant", { pin: PIN2 });
    assert.equal(broken.statusCode, 500);
    assert.equal(broken.json().code, "pin_verifier_unreadable");
    ctx.store.run("UPDATE pin SET verifier=? WHERE id=1", v);
    // The audit names the actions and the entry, never the PIN or a grant.
    const audit = ctx.store.all("SELECT action,target FROM audit WHERE action LIKE 'pin.%' ORDER BY created");
    const actions = audit.map((a) => a.action);
    for (const a of ["pin.set", "pin.grant.wrong", "pin.locked", "pin.grant", "pin.change", "pin.unreadable"])
      assert.ok(actions.includes(a), `audit has ${a}`);
    assert.ok(!actions.includes("pin.reset"));
    for (const a of audit) assert.equal(a.target, "pin@web", "the entry (P1-03's channel)");
    const secrets = [PIN, PIN2, grant, g2, tokenA, tokenB];
    for (const s of secrets) {
      assert.ok(!JSON.stringify(ctx.store.all("SELECT * FROM audit")).includes(s), "audit");
      // Answers carry a grant only where one was bought; never a PIN.
      if (s === PIN || s === PIN2)
        for (const b of bodies) assert.ok(!b.includes(s), `an answer echoes the PIN: ${b}`);
    }
    // P1-03: the command line on this machine (its credential, local face
    // only) may reset — no PIN needed (it is what you do when you forgot it).
    const cli = readCli(join(dir, "keys", "cli-credential"), "utf8").trim();
    const viaCli = await call("POST", "/api/pin/reset", { confirm: true }, cli);
    assert.equal(viaCli.statusCode, 200);
    assert.equal(ctx.pin.status().set, false);
    assert.equal(ctx.pin.status().resetVia, "cli");
    assert.equal(ctx.pin.check(g2, holderB), false);
  } finally {
    Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn, info: saved.info });
    process.stdout.write = saved.out;
    process.stderr.write = saved.err;
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // The log scan.
  const all = logged.join("\n");
  for (const s of [PIN, PIN2, "000000"])
    assert.ok(!all.includes(s), "a PIN reached the logs");
  for (const b of bodies) {
    const g = /"grant":"([^"]+)"/.exec(b)?.[1];
    if (g) assert.ok(!all.includes(g), "a grant reached the logs");
  }
});
