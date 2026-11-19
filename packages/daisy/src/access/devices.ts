/**
 * P5-03 (总纲 7.6 「配对」, 5.11, D-08, W-3, ADR-142): the owner's paired
 * devices — the codes that let one in, the device records, the trade of a
 * device credential for a device session.
 *
 * Three secrets, none kept in clear:
 *
 * - Pairing code (`daisy pair`, PIN): 10 Crockford base32 characters
 *   (50 random bits), in memory only as a SHA-256 of its normal form, for
 *   DEVICE_LIMITS.pairCodeTtlMs, good once, and only under the PIN epoch
 *   it was made in (a PIN set / change / reset voids it). Guessing
 *   (review L-2 of P5-03b): `redeemFailuresMax` wrong codes from one source
 *   lock that source for `redeemLockMs`; every code is voided after
 *   `codeWrongMax` wrong codes from all sources together in its life.
 * - Device credential (`ddev_` + 256 random bits): handed to the device
 *   once, only its SHA-256 is kept (`devices.secret_hash`). It is only
 *   ever sent to trade for a session; good until revoked, or unused for
 *   `idleExpiryMs`, on the face it was paired on.
 * - Device session: a web session (web-sessions.ts) marked with the
 *   device — the Bearer of every request, ≤ `sessionTtlMs` (D-38's 24 h
 *   for an owner credential from elsewhere is the ceiling). The guard
 *   counts it only while its device is active (`active`), on every request.
 *
 * Revoking (one by the owner, all at a PIN reset) is at once: the row, the
 * sessions, and — through `onRevoked` — the live sockets (app.ts closes
 * them); a request in flight is answered 401 by the guard's onSend check.
 */
import { englishText, type MsgParams } from "../app/errors.ts";
import type { MessageKey } from "../../../contracts/src/i18n.ts";
import { ownerT } from "../platform/language.ts";
import { createHash, randomBytes } from "node:crypto";
import type { Store } from "../store/index.ts";
import type { WebSessions } from "./web-sessions.ts";
import type { PinService } from "./pin-seam.ts";
import type { Face } from "./ports.ts";
import { registerSecret } from "../observe/redact.ts";
import { DEVICE_LIMITS } from "../../../contracts/src/limits.ts";
import type { Device, DeviceSession, PairingCode } from "../../../contracts/src/api/devices.ts";

export const DEVICE_PREFIX = "ddev_";
/** Crockford base32: no I, L, O, U (read alike, or a word). 32 symbols = 5 bits each. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 10;
/**
 * The faces a device may be paired on and used from. P5-02 / P5-03b: the
 * relay's streams are the outside face (faces.ts tags them `external`), so
 * a device paired on the direct listener is used through the relay and the
 * other way round — one face, one rule.
 */
export const DEVICE_FACES: readonly Face[] = ["external"];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A fresh pairing code, `XXXXX-XXXXX` (uniform: 5 bits of a random byte each). */
export function newPairingCode(): string {
  const b = randomBytes(CODE_CHARS);
  let s = "";
  for (let i = 0; i < CODE_CHARS; i++) s += ALPHABET[b[i]! & 31];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** What was typed, in normal form (upper case; spaces and dashes dropped; O→0, I/L→1) — or null. */
export function normalizePairingCode(raw: string): string | null {
  const s = String(raw)
    .toUpperCase()
    .replace(/[\s\-_.]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== CODE_CHARS) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return s;
}

/** A name or a browser's word: printable, one line, cut short (it is shown in the owner's list). */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v
    // Control characters and bidi overrides (a name must not reorder the list).
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? [...s].slice(0, max).join("") : null;
}

export class DeviceError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | "code_invalid"
      | "pair_locked"
      | "device_invalid"
      | "device_face"
      | "device_not_found"
      | "too_many_devices",
    /** P6-23b: the message key — the route says it in the request's language. */
    readonly key: MessageKey,
    readonly params: MsgParams = {},
    readonly retryAfter?: number,
  ) {
    super(englishText(key, params));
  }
}

interface PendingCode {
  expires: number;
  name: string | null;
  /** The PIN's epoch when the code was made (a set / change / reset since voids it). */
  epoch: number | undefined;
  by: string;
  /** Review L-2: wrong codes (from any source) since this one was made. */
  wrong: number;
}

type Row = {
  id: string;
  name: string;
  secret_hash: string;
  face: string;
  created_at: number;
  created_by: string;
  last_used_at: number | null;
  last_ip: string | null;
  user_agent: string | null;
  revoked_at: number | null;
  revoked_why: string | null;
};


export class Devices {
  private codes = new Map<string, PendingCode>();
  /** Review L-2: when each source's wrong codes of the current window came. */
  private failures = new Map<string, number[]>();
  /** Review L-2: the sources locked, and until when. */
  private locks = new Map<string, number>();
  /** When every wrong code of the current window came (all sources: the owner is told how many). */
  private recent: number[] = [];
  /** Last time `touch` wrote a device's last use (at most once a minute). */
  private touched = new Map<string, number>();
  private revokedListeners = new Set<(ids: string[] | null) => void>();
  private now: () => number;

  constructor(
    private store: Store,
    private web: WebSessions,
    private o: { pin: () => PinService | undefined; now?: () => number },
  ) {
    this.now = o.now ?? Date.now;
  }

  private epoch(): number | undefined {
    const p = this.o.pin();
    return p && typeof p.epoch === "function" ? p.epoch() : undefined;
  }
  private sweepCodes() {
    const t = this.now();
    for (const [k, c] of this.codes) if (c.expires <= t) this.codes.delete(k);
  }
  private row(id: string): Row | undefined {
    return this.store.one("SELECT * FROM devices WHERE id=?", id) as Row | undefined;
  }
  private stateOf(r: Row): Device["state"] {
    if (r.revoked_at) return "revoked";
    return this.now() - (r.last_used_at ?? r.created_at) >= DEVICE_LIMITS.idleExpiryMs ? "expired" : "active";
  }
  private view(r: Row, current?: string): Device {
    return {
      id: r.id,
      name: r.name,
      face: r.face === "local" ? "local" : "external",
      createdAt: r.created_at,
      createdBy: r.created_by,
      lastUsedAt: r.last_used_at ?? null,
      // P5-03b: `relay:<addr>` / `relay` (faces.ts callerOf) — the relay's word, or nothing.
      lastIp: r.last_ip?.startsWith("relay") ? r.last_ip.slice(6) || null : (r.last_ip ?? null),
      lastVia: r.last_ip?.startsWith("relay") ? "relay" : r.last_ip ? "direct" : null,
      userAgent: r.user_agent ?? null,
      state: this.stateOf(r),
      revokedAt: r.revoked_at ?? null,
      revokedWhy: (r.revoked_why as Device["revokedWhy"]) ?? null,
      current: !!current && current === r.id,
    };
  }
  private activeCount(): number {
    return this.store
      .all("SELECT id,created_at,last_used_at,revoked_at FROM devices WHERE revoked_at IS NULL")
      .filter((r: any) => this.stateOf(r) === "active").length;
  }

  // ── pairing codes ────────────────────────────────────────────────────
  private sweepLocks() {
    const t = this.now();
    for (const [k, until] of this.locks) if (until <= t) this.locks.delete(k);
    this.recent = this.recent.filter((x) => x > t - DEVICE_LIMITS.redeemLockMs);
    for (const [k, xs] of this.failures) {
      const live = xs.filter((x) => x > t - DEVICE_LIMITS.redeemLockMs);
      if (live.length) this.failures.set(k, live);
      else this.failures.delete(k);
    }
  }
  /** Review L-2: the sources locked now (设置 › 设备 shows each). */
  pairLocks(): { who: string; until: number }[] {
    this.sweepLocks();
    return [...this.locks].map(([who, until]) => ({ who, until })).sort((a, b) => a.until - b.until);
  }
  /** When the last pairing lock ends (null: none). */
  lockedUntilAt(): number | null {
    const l = this.pairLocks();
    return l.length ? l[l.length - 1]!.until : null;
  }
  /** Seconds `source` is still locked (no source: the longest lock), or 0. */
  lockedFor(source?: string): number {
    this.sweepLocks();
    const until = source === undefined ? Math.max(0, ...this.locks.values()) : (this.locks.get(source) ?? 0);
    const left = until - this.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /**
   * A new pairing code (the route has checked the PIN, and calls this
   * inside `commitLetIn`). The oldest unused one goes when there are too
   * many; none at all when the devices are already at their limit.
   */
  issueCode(name: string | undefined, by: string): Pick<PairingCode, "code" | "expiresAt" | "name" | "wasLocked" | "recentFailures"> {
    this.sweepCodes();
    // Review L-2 (P5-03): the owner (PIN) making a code is told a source is
    // locked and how many wrong codes came. P5-03b review L-2: the locks
    // stay — each holds only its own source, never this code for others.
    this.sweepLocks();
    const wasLocked = this.locks.size > 0;
    const recentFailures = this.recent.length;
    if (this.activeCount() >= DEVICE_LIMITS.activeMax)
      throw new DeviceError(409, "too_many_devices", "server-access.device.tooMany", { max: DEVICE_LIMITS.activeMax });
    while (this.codes.size >= DEVICE_LIMITS.pendingCodesMax) this.codes.delete(this.codes.keys().next().value!);
    const code = newPairingCode();
    const norm = normalizePairingCode(code)!;
    // S-1: neither spelling ever reaches a log line, an error or the audit.
    registerSecret(code);
    registerSecret(norm);
    const expiresAt = this.now() + DEVICE_LIMITS.pairCodeTtlMs;
    const clean = cleanText(name, DEVICE_LIMITS.nameMax);
    this.codes.set(sha(norm), { expires: expiresAt, name: clean, epoch: this.epoch(), by, wrong: 0 });
    return { code, expiresAt, name: clean, wasLocked, recentFailures };
  }

  /** Every unused code goes (the outside face closed; a PIN reset). */
  clearCodes(): number {
    const n = this.codes.size;
    this.codes.clear();
    return n;
  }

  /** How many unused codes there are (tests, the list). */
  pendingCodes(): number {
    this.sweepCodes();
    return this.codes.size;
  }

  private wrongCode(source: string): void {
    const t = this.now();
    this.sweepLocks();
    // This source: locked after `redeemFailuresMax` in the window (review L-2: that source only).
    this.recent.push(t);
    if (this.recent.length > 4 * DEVICE_LIMITS.lockSourcesMax) this.recent.shift();
    const xs = [...(this.failures.get(source) ?? []), t];
    this.failures.delete(source);
    if (xs.length >= DEVICE_LIMITS.redeemFailuresMax) {
      this.locks.delete(source);
      this.locks.set(source, t + DEVICE_LIMITS.redeemLockMs);
      while (this.locks.size > DEVICE_LIMITS.lockSourcesMax) this.locks.delete(this.locks.keys().next().value!);
      try {
        this.store.audit("anonymous", "device.pair.locked", JSON.stringify({ who: source, minutes: DEVICE_LIMITS.redeemLockMs / 60_000 }), {
          object: "devices",
          outcome: "denied",
          reason: "pair_locked",
        });
      } catch {}
    } else {
      this.failures.set(source, xs);
      while (this.failures.size > DEVICE_LIMITS.lockSourcesMax) this.failures.delete(this.failures.keys().next().value!);
    }
    // Every code, over all sources: voided after `codeWrongMax` wrong codes in its life.
    let voided = 0;
    for (const [k, c] of this.codes)
      if (++c.wrong >= DEVICE_LIMITS.codeWrongMax) {
        this.codes.delete(k);
        voided++;
      }
    if (voided)
      try {
        this.store.audit("anonymous", "device.pair.voided", JSON.stringify({ voided, wrong: DEVICE_LIMITS.codeWrongMax }), {
          object: "devices",
          outcome: "denied",
          reason: "code_invalid",
        });
      } catch {}
  }

  /**
   * Another device trades a pairing code for its record, its device
   * credential and a first session. The code is used up before anything
   * else can happen (one use, even when what follows fails).
   */
  redeem(
    raw: string,
    m: { face: Face; name?: string; userAgent?: string; ip?: string; bucket?: string },
  ): { device: Device; secret: string; session: DeviceSession } {
    // Review L-2: the source wrong codes are counted and locked by (the rate-limit bucket).
    const source = m.bucket ?? "?";
    // Review M-1: nothing an anonymous caller sends is registered as a
    // secret before it matched (it would mask ordinary words in every
    // audit row, and flood the registry) — only the code that did, below.
    if (!DEVICE_FACES.includes(m.face))
      throw new DeviceError(403, "device_face", "server-access.device.pairFace");
    const locked = this.lockedFor(source);
    if (locked)
      throw new DeviceError(423, "pair_locked", "server-access.device.pairLocked", { minutes: Math.ceil(locked / 60) }, locked);
    this.sweepCodes();
    const norm = normalizePairingCode(raw);
    const key = norm ? sha(norm) : "";
    const c = norm ? this.codes.get(key) : undefined;
    if (c) this.codes.delete(key); // one use — and a voided one is gone too
    if (!c || c.expires <= this.now() || c.epoch !== this.epoch()) {
      this.wrongCode(source);
      throw new DeviceError(401, "code_invalid", "server-access.device.codeInvalid");
    }
    this.failures.delete(source);
    // It matched: its typed spelling is a secret from now on too.
    registerSecret(raw);
    registerSecret(norm);
    if (this.activeCount() >= DEVICE_LIMITS.activeMax)
      throw new DeviceError(409, "too_many_devices", "server-access.device.tooManyOwner", { max: DEVICE_LIMITS.activeMax });
    const id = "dev_" + randomBytes(9).toString("base64url");
    const secret = DEVICE_PREFIX + randomBytes(32).toString("base64url");
    registerSecret(secret);
    const t = this.now();
    const name = c.name ?? cleanText(m.name, DEVICE_LIMITS.nameMax) ?? ownerT()("server-access.device.defaultName", { id: id.slice(4, 8) });
    this.store.run(
      "INSERT INTO devices(id,name,secret_hash,face,created_at,created_by,last_used_at,last_ip,user_agent) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      name,
      sha(secret),
      m.face,
      t,
      c.by,
      t,
      cleanText(m.ip, 64),
      cleanText(m.userAgent, DEVICE_LIMITS.userAgentMax),
    );
    const s = this.openSession(id, m.face);
    return { device: this.view(this.row(id)!, id), secret, session: s };
  }

  private openSession(id: string, face: Face): DeviceSession {
    const s = this.web.open(face, true, {
      device: id,
      ttlMs: DEVICE_LIMITS.sessionTtlMs,
      perDevice: DEVICE_LIMITS.sessionsPerDevice,
    });
    return { deviceId: id, token: s.token, expiresAt: s.expiresAt, face };
  }

  /** A paired device trades its credential for a new session (on its own face). */
  exchange(secret: string, m: { face: Face; ip?: string }): DeviceSession {
    const r =
      typeof secret === "string" && secret.startsWith(DEVICE_PREFIX)
        ? (this.store.one("SELECT * FROM devices WHERE secret_hash=?", sha(secret)) as Row | undefined)
        : undefined;
    if (!DEVICE_FACES.includes(m.face))
      throw new DeviceError(403, "device_face", "server-access.device.deviceFace");
    if (!r || this.stateOf(r) !== "active" || r.face !== m.face)
      throw new DeviceError(401, "device_invalid", "server-access.device.deviceInvalid");
    // Review M-1: registered only once it matched an active device.
    registerSecret(secret);
    this.store.run("UPDATE devices SET last_used_at=?,last_ip=? WHERE id=?", this.now(), cleanText(m.ip, 64), r.id);
    this.touched.set(r.id, this.now());
    return this.openSession(r.id, m.face);
  }

  /**
   * Is device `id` one whose sessions count (not revoked, not idle too
   * long, used on its own face)? The guard asks on every request.
   */
  active(id: string, face: Face): boolean {
    const r = this.row(id);
    return !!r && r.face === face && this.stateOf(r) === "active";
  }

  /** A request came with the device's session: note it (at most once a minute). */
  touch(id: string, ip?: string): void {
    const t = this.now();
    if (t - (this.touched.get(id) ?? 0) < 60_000) return;
    this.touched.set(id, t);
    try {
      this.store.run("UPDATE devices SET last_used_at=?,last_ip=? WHERE id=? AND revoked_at IS NULL", t, cleanText(ip, 64), id);
    } catch {}
  }

  /** The records (never a credential); `all`: revoked and expired too (kept 30 days). */
  list(state: "active" | "all", current?: string): Device[] {
    const t = this.now();
    this.store.run("DELETE FROM devices WHERE revoked_at IS NOT NULL AND revoked_at < ?", t - DEVICE_LIMITS.keepMs);
    const rows = this.store.all("SELECT * FROM devices ORDER BY created_at DESC") as Row[];
    return rows
      .filter((r) => {
        if (state === "all") return r.revoked_at || t - (r.last_used_at ?? r.created_at) < DEVICE_LIMITS.idleExpiryMs + DEVICE_LIMITS.keepMs;
        return this.stateOf(r) === "active";
      })
      .map((r) => this.view(r, current));
  }

  /** Let others know a device (null: every device) was revoked — app.ts closes their live sockets. */
  onRevoked(fn: (ids: string[] | null) => void): () => void {
    this.revokedListeners.add(fn);
    return () => void this.revokedListeners.delete(fn);
  }
  private tell(ids: string[] | null) {
    for (const f of this.revokedListeners)
      try {
        f(ids);
      } catch {}
  }

  /**
   * Revoke one device (synchronous: the route calls it inside
   * `commitLetIn`). At once: the record, its sessions, its sockets.
   * Already revoked: the record as it is.
   */
  revoke(id: string, why: "owner" | "self", by: string, current?: string): Device {
    const r = this.row(id);
    if (!r) throw new DeviceError(404, "device_not_found", "server-access.device.notFound", { id: String(id).slice(0, 64) });
    if (!r.revoked_at)
      this.store.run(
        "UPDATE devices SET revoked_at=?,revoked_why=?,revoked_by=? WHERE id=? AND revoked_at IS NULL",
        this.now(),
        why,
        by,
        id,
      );
    this.web.dropDevice(id);
    this.touched.delete(id);
    this.tell([id]);
    return this.view(this.row(id)!, current);
  }

  /** PIN reset (T-9), in its transaction: every device's record. Returns how many were active. */
  revokeAllRecords(): number {
    return Number(
      this.store.run(
        "UPDATE devices SET revoked_at=?,revoked_why='pin_reset',revoked_by='cli' WHERE revoked_at IS NULL",
        this.now(),
      ).changes,
    );
  }

  /** PIN reset, after its transaction's hooks: the unused codes, every device session, every device socket. */
  dropEverything(): void {
    this.clearCodes();
    this.failures.clear();
    this.recent = [];
    // Review L-2: a lock does not outlive the PIN it was under.
    this.locks.clear();
    this.web.dropDevice(null);
    this.touched.clear();
    this.tell(null);
  }
}
