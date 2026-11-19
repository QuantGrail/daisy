/**
 * P1-03 (D-09, 5.12, ADR-110): the web page's credentials.
 *
 * - One-time code: 128 random bits, valid 10 minutes, used once, for one
 *   face. `daisy open` gets one with the command-line credential
 *   (POST /api/web/open-code) and prints a link that carries it after `#`
 *   (never in a request line, so never in a log). Kept in memory only, as
 *   SHA-256: a restart drops every unused code.
 * - Session: 256 random bits, sent as `Authorization: Bearer` — not a
 *   cookie, so no other page can make the browser send it (cross-site
 *   requests are refused anyway, guard.ts) and, unlike a cookie, it is
 *   not shared between ports of 127.0.0.1 (another Daisy on this host).
 *   Valid on the face it was issued for only; local 30 days, outside 7
 *   days. Only the SHA-256 is kept (keys/web-sessions.json, 0600).
 * - A session made without a code (this machine, passcode off) is marked
 *   so; once the passcode applies (outside face on, a shared machine, the
 *   owner turned it on) it no longer counts (guard.ts).
 * - P5-03 (ADR-142): a paired device's session is one of these too, marked
 *   with its device (`device`): shorter (DEVICE_LIMITS.sessionTtlMs), at
 *   most a few per device, and counted only while the device is (the
 *   guard asks access/devices.ts on every request). Revoking the device
 *   drops them (`dropDevice`).
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureKeysDir, exists, writeSecret } from "./keys.ts";
import type { Face } from "./ports.ts";
import { registerSecret } from "../observe/redact.ts";

export const WEB_PREFIX = "dweb_";
export const CODE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS: Record<Face, number> = {
  local: 30 * 86400_000,
  external: 7 * 86400_000,
};
const MAX_CODES = 100;
const MAX_SESSIONS = 200;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface WebSession {
  hash: string;
  face: Face;
  created: number;
  expires: number;
  /** Made with a one-time code (false: no passcode then, this machine). */
  viaCode: boolean;
  /** P5-03: a paired device's session — that device's id. */
  device?: string;
}

export class WebSessions {
  private codes = new Map<string, { face: Face; expires: number }>();
  private sessions = new Map<string, WebSession>();
  private file: string;
  constructor(
    dataDir: string,
    private now: () => number = Date.now,
  ) {
    ensureKeysDir(dataDir);
    this.file = join(dataDir, "keys", "web-sessions.json");
    try {
      if (exists(this.file))
        for (const s of JSON.parse(readFileSync(this.file, "utf8")) as WebSession[])
          if (
            typeof s?.hash === "string" &&
            (s.face === "local" || s.face === "external") &&
            s.expires > this.now()
          )
            this.sessions.set(s.hash, {
              hash: s.hash,
              face: s.face,
              created: s.created,
              expires: s.expires,
              viaCode: s.viaCode === true,
              ...(typeof s.device === "string" && s.device ? { device: s.device } : {}),
            });
    } catch {
      // Unreadable: every page logs in again (never more open).
      this.sessions.clear();
    }
  }
  private save() {
    writeSecret(this.file, JSON.stringify([...this.sessions.values()]));
  }
  private sweep() {
    const t = this.now();
    for (const [k, c] of this.codes) if (c.expires <= t) this.codes.delete(k);
    let changed = false;
    for (const [k, s] of this.sessions)
      if (s.expires <= t) {
        this.sessions.delete(k);
        changed = true;
      }
    return changed;
  }
  /** A one-time code for `face`. */
  issueCode(face: Face): { code: string; expiresAt: number } {
    this.sweep();
    while (this.codes.size >= MAX_CODES)
      this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(16).toString("base64url");
    registerSecret(code); // S-1
    const expiresAt = this.now() + CODE_TTL_MS;
    this.codes.set(sha(code), { face, expires: expiresAt });
    return { code, expiresAt };
  }
  /** Use a code up (once, on its own face only). */
  takeCode(code: string, face: Face): boolean {
    this.sweep();
    const k = sha(code),
      c = this.codes.get(k);
    if (!c || c.face !== face) return false;
    this.codes.delete(k);
    return true;
  }
  /**
   * A new session for `face`. P5-03: `device` — a paired device's (its
   * id), lasting `ttlMs`; its oldest goes once it has `perDevice`.
   */
  open(
    face: Face,
    viaCode: boolean,
    o: { device?: string; ttlMs?: number; perDevice?: number } = {},
  ): { token: string; expiresAt: number } {
    this.sweep();
    if (o.device && o.perDevice) {
      const mine = [...this.sessions.values()]
        .filter((x) => x.device === o.device)
        .sort((a, b) => a.created - b.created);
      while (mine.length >= o.perDevice) this.sessions.delete(mine.shift()!.hash);
    }
    // Full: the oldest code-less session goes first (review L-7: a flood
    // of code-less asks must not push out the sessions made with a code).
    while (this.sessions.size >= MAX_SESSIONS) {
      const codeless = [...this.sessions.values()].find((x) => !x.viaCode);
      this.sessions.delete(codeless?.hash ?? this.sessions.keys().next().value!);
    }
    const token = WEB_PREFIX + randomBytes(32).toString("base64url");
    registerSecret(token);
    const s: WebSession = {
      hash: sha(token),
      face,
      created: this.now(),
      expires: this.now() + (o.ttlMs ?? SESSION_TTL_MS[face]),
      viaCode,
      ...(o.device ? { device: o.device } : {}),
    };
    this.sessions.set(s.hash, s);
    this.save();
    return { token, expiresAt: s.expires };
  }
  /** The live session `token` names, if any. */
  find(token: string): WebSession | undefined {
    const s = this.sessions.get(sha(token));
    if (!s) return undefined;
    if (s.expires <= this.now()) {
      this.sessions.delete(s.hash);
      this.save();
      return undefined;
    }
    return s;
  }
  close(hash: string): void {
    if (this.sessions.delete(hash)) this.save();
  }
  /** P5-03: drop every session of device `id` (null: of every paired device). Returns how many. */
  dropDevice(id: string | null): number {
    let n = 0;
    for (const [k, s] of this.sessions)
      if (s.device && (id === null || s.device === id)) {
        this.sessions.delete(k);
        n++;
      }
    if (n) this.save();
    return n;
  }
  /** Drop every session (and code) of `face`; with `codeless`, only those made without a code. */
  drop(face: Face, codeless = false): void {
    for (const [k, c] of this.codes) if (c.face === face && !codeless) this.codes.delete(k);
    let changed = false;
    for (const [k, s] of this.sessions)
      if (s.face === face && (!codeless || !s.viaCode)) {
        this.sessions.delete(k);
        changed = true;
      }
    if (changed) this.save();
  }
}
