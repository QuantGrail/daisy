/**
 * P1-05: the PIN (5.11 「PIN 码」, D-11, D-32, D-36, ADR-099
 * recommendation 5, limits.md §6, local-api.md §6).
 *
 * - Only a verifier is kept: scrypt (N = 2^17, r = 8, p = 1, a random
 *   16-byte salt) of the NFKC form, its parameters stored with it so a
 *   stronger setting upgrades it on the next right entry. Never the PIN.
 *   A verifier outside the expected shape is refused (fail closed).
 * - Consecutive wrong PINs (handing in a grant, or the old PIN of a
 *   change) lock entry: 5 → 15 min, the next 5 → 1 h, then doubling up to
 *   24 h; one right PIN clears it. Each entry is counted *before* it is
 *   hashed (in one BEGIN IMMEDIATE transaction; the 5th locks at once) and
 *   only a right one clears the count, so a crash, a second process or a
 *   later asynchronous hash cannot lose a count. The lock is in the
 *   database (a restart does not clear it), with its start: a clock that
 *   jumped makes it at most one lock long from now. While locked nothing
 *   is hashed.
 * - A right PIN buys a grant: 32 random bytes, valid 5 minutes, bound to
 *   the credential that asked (local-api.md §6.3). Only its SHA-256 is
 *   stored; checking compares in constant time.
 * - D-36: whether a PIN is set gates every AI turn (app/runner-api.ts,
 *   live.ts, app/messages.ts); when and through which entry it was last
 *   set and reset is kept for the owner's notice.
 * - `resetLocal` (on this machine only — the route's channel check is
 *   P1-03's) drops the PIN and every grant and runs the `onReset` hooks in
 *   the same transaction (stage 4: revoke outside grants, contacts,
 *   devices), so a reset never leaves an old permission standing.
 *
 * S-1: neither the PIN nor a grant ever reaches an error, a log line or
 * the audit. The interface below is what P1-03 / P4-02 call.
 */
import { ownerT } from "../platform/language.ts";
import type { MsgParams } from "../app/errors.ts";
import type { MessageKey, Translate } from "../../../contracts/src/i18n.ts";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { StoreBase } from "../store/base.ts";
import { HttpError, sayMsg } from "../app/errors.ts";
import {
  PIN_GRANT_HEADER,
  PIN_LIMITS,
  normalizePin,
  pinLockMs,
  pinRuleError,
  type PinStatus,
  type PinVia,
} from "../../../contracts/src/index.ts";
import { PIN_RULE_PARAMS } from "../../../contracts/src/api/pin.ts";
import { registerSecret } from "../observe/redact.ts";

export { PIN_GRANT_HEADER };
export type { PinStatus, PinVia };

export interface PinService {
  /** Set or not, locked until when, last set / reset (when, which entry). */
  status(): PinStatus;
  /**
   * First time: no `oldPin`. Changing: the old PIN (a wrong one counts).
   * `via`: the entry it came through (audit, D-36 notice).
   */
  set(newPin: string, oldPin?: string, via?: PinVia): void;
  /**
   * Check the PIN; a right one buys a short-lived grant bound to `holder`
   * (local-api.md §6.3: the credential that asked — a web session, a
   * device, a command-line credential).
   */
  grant(pin: string, holder: string): { grant: string; expiresAt: number };
  /** Is this a live grant bought by this same holder? */
  check(grant: string | undefined, holder: string | undefined): boolean;
  /**
   * As `check`, and a grant that passes is spent in the same transaction:
   * one use only (local-api.md §6.5 — the command line uses a grant once
   * and drops it). False changes nothing.
   */
  consume(grant: string | undefined, holder: string | undefined): boolean;
  /** On this machine only: drop the PIN and every grant, run the hooks. */
  resetLocal(via?: PinVia): void;
  onReset(fn: () => void): void;
  /**
   * P4-02 review M-1: changes whenever the PIN is set, changed or reset
   * (in this process — the one that serves every request). A grant
   * checked under one epoch is no good for persisting under another
   * (access/let-in-commit.ts).
   */
  epoch(): number;
}

export interface PinServiceOptions {
  /** The clock (tests). */
  now?: () => number;
  /**
   * The scrypt cost of new verifiers (default PIN_LIMITS.scrypt: 2^17, 8,
   * 1). Tests lower it to stay fast; a verifier keeps its own parameters.
   */
  scrypt?: { log2N: number; r: number; p: number };
}

/** A refused PIN action: what happened and what to do (3.7), no secrets. */
export class PinError extends HttpError {
  /** P6-23b: said in the request's language by the error handler; `message` is the owner's language. */
  readonly localized = true;
  constructor(
    statusCode: number,
    public key: MessageKey,
    public params: MsgParams,
    code: string,
    /** Seconds until the lock ends (pin_locked). */
    public retryAfter?: number,
    /** This very attempt set the lock off (for the audit). */
    public justLocked = false,
  ) {
    super(statusCode, sayMsg(ownerT(), key, params), code);
  }
}

/** D-36: what to do while no PIN is set (P6-23b: in `t`'s language, the owner's by default). */
export const pinSetHint = (t: Translate = ownerT()) => t("server-access.pin.setHint");
/** @deprecated said once, in the owner's language at start: use `pinSetHint()`. */
export const PIN_SET_HINT = pinSetHint();

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));
const lockedError = (until: number, now: number, justLocked = false) =>
  new PinError(
    423,
    justLocked ? "server-access.pin.lockedNow" : "server-access.pin.locked",
    { n: PIN_LIMITS.attemptsPerRound, minutes: minutes(until - now) },
    "pin_locked",
    Math.ceil((until - now) / 1000),
    justLocked,
  );
const notSetError = () =>
  new PinError(
    409,
    "server-access.pin.notSet",
    { min: PIN_LIMITS.minLength },
    "pin_not_set",
  );

interface Cost {
  log2N: number;
  r: number;
  p: number;
}
const SALT = PIN_LIMITS.scrypt.saltBytes,
  KEY = PIN_LIMITS.scrypt.keyBytes;
// `scrypt$norm=nfkc,ln=17,r=8,p=1$<salt>$<key>` (base64url).
const VERIFIER =
  /^scrypt\$norm=nfkc,ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;
/** Bounds a stored verifier must keep (a larger one could exhaust memory). */
const BOUNDS = { log2N: [10, 20], r: [1, 32], p: [1, 16] } as const;

function derive(pin: string, salt: Buffer, c: Cost): Buffer {
  const N = 2 ** c.log2N;
  // scrypt needs about 128·N·r bytes (128 MiB at the default); Node's
  // default ceiling is 32 MiB, so give it room (ADR-099).
  return scryptSync(normalizePin(pin), salt, KEY, {
    N,
    r: c.r,
    p: c.p,
    maxmem: 256 * N * c.r + 32 * 1024 * 1024,
  });
}
function makeVerifier(pin: string, c: Cost): string {
  const salt = randomBytes(SALT);
  const key = derive(pin, salt, c);
  return `scrypt$norm=nfkc,ln=${c.log2N},r=${c.r},p=${c.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export const unreadableError = () =>
  new PinError(
    500,
    "server-access.pin.unreadable",
    {},
    "pin_verifier_unreadable",
  );
function parseVerifier(v: string): { cost: Cost; salt: Buffer; key: Buffer } {
  const m = VERIFIER.exec(v);
  if (!m) throw unreadableError();
  const cost = { log2N: +m[1]!, r: +m[2]!, p: +m[3]! };
  const salt = Buffer.from(m[4]!, "base64url"),
    key = Buffer.from(m[5]!, "base64url");
  const within = (x: number, [lo, hi]: readonly [number, number]) =>
    x >= lo && x <= hi;
  if (
    !within(cost.log2N, BOUNDS.log2N) ||
    !within(cost.r, BOUNDS.r) ||
    !within(cost.p, BOUNDS.p) ||
    salt.length !== SALT ||
    key.length !== KEY
  )
    throw unreadableError();
  return { cost, salt, key };
}
const work = (c: Cost) => 2 ** c.log2N * c.r * c.p;
const sha256 = (s: string) => createHash("sha256").update(s).digest();
const validHolder = (h: unknown): h is string =>
  typeof h === "string" && h.length > 0 && h.length <= 500;

interface PinRow {
  verifier: string | null;
  failures: number;
  rounds: number;
  locked_at: number;
  locked_until: number;
  set_at: number | null;
  set_via: PinVia | null;
  reset_at: number | null;
  reset_via: PinVia | null;
}
const EMPTY: PinRow = {
  verifier: null,
  failures: 0,
  rounds: 0,
  locked_at: 0,
  locked_until: 0,
  set_at: null,
  set_via: null,
  reset_at: null,
  reset_via: null,
};
const CLEAR = { failures: 0, rounds: 0, locked_at: 0, locked_until: 0 };

export function createPinService(
  store: StoreBase,
  opts: PinServiceOptions = {},
): PinService {
  const now = opts.now ?? Date.now;
  const cost: Cost = opts.scrypt ?? {
    log2N: PIN_LIMITS.scrypt.log2N,
    r: PIN_LIMITS.scrypt.r,
    p: PIN_LIMITS.scrypt.p,
  };
  const hooks: (() => void)[] = [];
  let epoch = 0;

  const read = (): PinRow =>
    store.one(
      "SELECT verifier,failures,rounds,locked_at,locked_until,set_at,set_via,reset_at,reset_via FROM pin WHERE id=1",
    ) ?? { ...EMPTY };
  const save = (r: PinRow) =>
    store.run(
      `INSERT INTO pin(id,verifier,failures,rounds,locked_at,locked_until,set_at,set_via,reset_at,reset_via,updated) VALUES(1,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET verifier=excluded.verifier,failures=excluded.failures,rounds=excluded.rounds,locked_at=excluded.locked_at,locked_until=excluded.locked_until,set_at=excluded.set_at,set_via=excluded.set_via,reset_at=excluded.reset_at,reset_via=excluded.reset_via,updated=excluded.updated`,
      r.verifier,
      r.failures,
      r.rounds,
      r.locked_at,
      r.locked_until,
      r.set_at,
      r.set_via,
      r.reset_at,
      r.reset_via,
      now(),
    );
  /**
   * The row, its lock corrected for a clock that moved: a lock that
   * started in the future, or ends further away than its round's length,
   * is recomputed as one lock from now (and written back).
   */
  function row(t: number): PinRow {
    const r = read();
    const span = pinLockMs(Math.max(1, r.rounds));
    if (
      r.locked_until > t &&
      (t < r.locked_at || r.locked_until - t > span)
    ) {
      const fixed = { ...r, locked_at: t, locked_until: t + span };
      save(fixed);
      return fixed;
    }
    return r;
  }
  const lockedUntil = (r: PinRow, t: number) =>
    r.locked_until > t ? r.locked_until : null;

  /**
   * One PIN entry against the stored verifier. Counted first (a full
   * round locks right away), then hashed outside the transaction; only a
   * right PIN clears the count. Refuses without hashing while locked.
   */
  function attempt(pin: string): void {
    const t = now();
    const step = store.atomic(() => {
      const r = row(t);
      if (!r.verifier) return { refuse: notSetError() };
      const until = lockedUntil(r, t);
      if (until) return { refuse: lockedError(until, t) };
      const v = parseVerifier(r.verifier);
      const next =
        r.failures + 1 >= PIN_LIMITS.attemptsPerRound
          ? {
              ...r,
              failures: 0,
              rounds: r.rounds + 1,
              locked_at: t,
              locked_until: t + pinLockMs(r.rounds + 1),
            }
          : { ...r, failures: r.failures + 1 };
      save(next);
      return { v, next, verifier: r.verifier };
    });
    if ("refuse" in step) throw step.refuse;
    const { v, next } = step;
    // A PIN outside the rule cannot be the right one: counted, not hashed.
    const right =
      typeof pin === "string" &&
      pinRuleError(pin) === null &&
      timingSafeEqual(derive(pin, v.salt, v.cost), v.key);
    if (right) {
      // A verifier made with a weaker setting than today's is upgraded.
      const upgraded =
        work(v.cost) < work(cost) ? makeVerifier(pin, cost) : null;
      store.atomic(() => {
        const r = read();
        save({
          ...r,
          ...CLEAR,
          // Changed meanwhile (another process): leave the new one alone.
          verifier:
            upgraded && r.verifier === step.verifier ? upgraded : r.verifier,
        });
      });
      return;
    }
    if (next.failures === 0) throw lockedError(next.locked_until, t, true);
    const left = PIN_LIMITS.attemptsPerRound - next.failures;
    throw new PinError(
      403,
      "server-access.pin.wrong",
      { left },
      "pin_wrong",
    );
  }

  /**
   * The stored hash of `grant` when it is live and was bought by `holder`,
   * else null. A grant is 43 base64url characters; anything else is not
   * one. A grant always belongs to someone: no holder, no grant. Every live
   * grant is compared, each in constant time.
   */
  function liveGrant(grant: unknown, holder: unknown): string | null {
    if (typeof grant !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(grant))
      return null;
    if (!validHolder(holder)) return null;
    const h = sha256(grant),
      who = sha256(holder);
    let found: string | null = null;
    for (const g of store.all(
      "SELECT hash,holder FROM pin_grants WHERE expires>?",
      now(),
    )) {
      const mine =
        typeof g.holder === "string" &&
        g.holder.length > 0 &&
        timingSafeEqual(sha256(g.holder), who);
      if (timingSafeEqual(Buffer.from(g.hash, "hex"), h) && mine) found = g.hash;
    }
    return found;
  }

  return {
    status() {
      const t = now();
      const r = row(t);
      return {
        set: !!r.verifier,
        lockedUntil: lockedUntil(r, t),
        setAt: r.set_at,
        setVia: r.set_via,
        resetAt: r.reset_at,
        resetVia: r.reset_via,
      };
    },
    set(newPin, oldPin, via = "unknown") {
      // P6-23a: the rule's reason is a key (`api.pin.rule.*`); said, with
      // its sentence, in the request's language (a nested message).
      const problem = typeof newPin === "string" ? pinRuleError(newPin) : "api.pin.rule.notText";
      if (problem)
        throw new PinError(400, "api.pin.rule.message", { problem: { key: problem, params: PIN_RULE_PARAMS } }, "pin_invalid");
      const before = read().verifier;
      if (before) {
        if (oldPin === undefined)
          throw new PinError(
            400,
            "server-access.pin.oldRequired",
            {},
            "pin_old_required",
          );
        attempt(oldPin);
      }
      const verifier = makeVerifier(newPin, cost);
      store.atomic(() => {
        const r = read();
        // Set or changed elsewhere since this call looked: start over.
        if (r.verifier !== before)
          throw new PinError(
            409,
            "server-access.pin.changedElsewhere",
            {},
            "pin_changed",
          );
        save({ ...r, ...CLEAR, verifier, set_at: now(), set_via: via });
        // A new PIN ends what the old one bought.
        store.run("DELETE FROM pin_grants");
        epoch++;
      });
    },
    grant(pin, holder) {
      if (!validHolder(holder))
        throw new TypeError("a PIN grant must be bound to the credential holding it (holder)");
      attempt(pin);
      const t = now();
      const grant = randomBytes(32).toString("base64url");
      registerSecret(grant); // S-1 (P1-11): never in a log line or error
      const expiresAt = t + PIN_LIMITS.grantTtlMs;
      store.run("DELETE FROM pin_grants WHERE expires<=?", t);
      store.run(
        "INSERT INTO pin_grants(hash,holder,expires,created) VALUES(?,?,?,?)",
        sha256(grant).toString("hex"),
        holder,
        expiresAt,
        t,
      );
      return { grant, expiresAt };
    },
    check(grant, holder) {
      return liveGrant(grant, holder) !== null;
    },
    consume(grant, holder) {
      return store.atomic(() => {
        const h = liveGrant(grant, holder);
        if (h === null) return false;
        store.run("DELETE FROM pin_grants WHERE hash=?", h);
        return true;
      });
    },
    resetLocal(via = "local") {
      // Before anything: a request whose grant passed earlier can no longer
      // persist (review M-1), even if this reset is then undone.
      epoch++;
      store.atomic(() => {
        store.run("DELETE FROM pin_grants");
        save({
          ...read(),
          ...CLEAR,
          verifier: null,
          reset_at: now(),
          reset_via: via,
        });
        // In the same transaction: a hook that fails undoes the reset.
        for (const fn of hooks) fn();
      });
    },
    onReset(fn) {
      hooks.push(fn);
    },
    epoch: () => epoch,
  };
}
