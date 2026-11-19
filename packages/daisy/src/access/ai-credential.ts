/**
 * P1-03 (5.11 「AI 工作凭据」, token.md §3 / §4.1 / §5, ADR-099 A1 + B2,
 * ADR-110): an AI's working credential — one per turn, good for that turn
 * and that session only, never longer than an hour.
 *
 * A JWT access token (RFC 9068, `typ: at+jwt`) signed with this Daisy's
 * Ed25519 identity key (keys/identity-key.json, 0600) through `jose`:
 *
 *   iss = sub = aud = urn:ietf:params:oauth:jwk-thumbprint:sha-256:<thumbprint>
 *   (`kid`: the same key's identity number, base32 — D-40 ④)
 *   client_id = ai:<session id>     act = { sub: agent:<session id> }
 *   scope = "daisy:tools daisy:session:read"   daisy_turn = <job id>
 *
 * Signing and the common checks are P2-01's SelfIssuer (tokens/
 * self-issuer.ts): the signature (EdDSA / Ed25519 only, never `none` or a
 * symmetric algorithm), `typ`, `kid`, issuer, audience, `exp - iat` ≤ 1 h;
 * here the claims above; the guard then checks the turn is still running in
 * this session (token.md §4.1 step 8). A turn longer than 50 minutes gets
 * a fresh one in the same file before the old one runs out.
 *
 * Delivery: run/ai/<session id> (0600) in the data directory, rewritten at
 * each turn start; the harness gets the path in DAISY_AI_CREDENTIAL_FILE
 * (an online process outlives its first turn, so an environment variable
 * holding the token itself would go stale).
 */
import { mkdirSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { writeSecret } from "./keys.ts";
import { SelfIssuer } from "./tokens/self-issuer.ts";
import { registerSecret } from "../observe/redact.ts";

export const AI_TTL_S = 3600;
export const AI_RENEW_S = 600;
export const AI_SCOPES = ["daisy:tools", "daisy:session:read"] as const;

export interface AiClaims {
  sessionId: string;
  jobId: string;
  jti: string;
  exp: number;
}

export class AiCredentials {
  private constructor(
    private dataDir: string,
    /** P2-01: this Daisy as its own issuer (tokens/self-issuer.ts). */
    readonly self: SelfIssuer,
  ) {}
  get kid() {
    return this.self.kid;
  }
  /** This Daisy's identity (URN of its key's RFC 7638 thumbprint). */
  get urn() {
    return this.self.urn;
  }
  static async open(dataDir: string): Promise<AiCredentials> {
    const self = await SelfIssuer.open(dataDir);
    // Review L-5: credentials a previous run left behind go (their turns
    // ended with that process; nothing would ever delete them).
    rmSync(join(dataDir, "run", "ai"), { recursive: true, force: true });
    return new AiCredentials(dataDir, self);
  }
  /** A credential for turn `jobId` of session `sessionId`. */
  async issue(
    sessionId: string,
    jobId: string,
    ttlS = AI_TTL_S,
  ): Promise<{ token: string; exp: number; jti: string }> {
    const { token, exp, jti } = await this.self.sign({
      sub: this.urn,
      aud: this.urn,
      clientId: `ai:${sessionId}`,
      scope: AI_SCOPES.join(" "),
      act: { sub: `agent:${sessionId}` },
      ttlS: Math.min(ttlS, AI_TTL_S),
      extra: { daisy_turn: jobId },
    });
    registerSecret(token); // S-1
    return { token, exp, jti };
  }
  /** The claims of a valid credential; null when anything is off. */
  async verify(token: string): Promise<AiClaims | null> {
    const r = await this.self.verify(token, { audience: this.urn, maxLifetimeS: AI_TTL_S });
    if (!r.ok) return null;
    const t = r.token;
    if (t.subject !== this.urn) return null;
    if (!t.clientId.startsWith("ai:")) return null;
    const sessionId = t.clientId.slice(3);
    if (!sessionId || t.act?.sub !== `agent:${sessionId}`) return null;
    if (t.claims.scope !== AI_SCOPES.join(" ")) return null;
    const turn = (t.claims as Record<string, unknown>).daisy_turn;
    if (typeof turn !== "string" || !turn) return null;
    return { sessionId, jobId: turn, jti: t.jti, exp: t.exp };
  }
  // ── delivery to the harness ───────────────────────────────────────────
  private dir() {
    const d = join(this.dataDir, "run", "ai");
    mkdirSync(d, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      chmodSync(join(this.dataDir, "run"), 0o700);
      chmodSync(d, 0o700);
    }
    return d;
  }
  /** Where session `sessionId`'s current credential is (DAISY_AI_CREDENTIAL_FILE). */
  fileOf(sessionId: string) {
    return join(this.dataDir, "run", "ai", sessionId.replace(/[^\w.-]/g, "_"));
  }
  private live = new Map<string, { jobId: string; exp: number }>();
  /** A turn starts: a fresh credential in the session's file. */
  async startTurn(sessionId: string, jobId: string): Promise<string> {
    this.dir();
    const { token, exp } = await this.issue(sessionId, jobId);
    writeSecret(this.fileOf(sessionId), token + "\n");
    this.live.set(sessionId, { jobId, exp });
    return this.fileOf(sessionId);
  }
  /**
   * Every few seconds: a turn that ended loses its file; one about to
   * outlive its credential gets a new one.
   */
  async sweep(running: (sessionId: string, jobId: string) => boolean) {
    const now = Math.floor(Date.now() / 1000);
    for (const [sid, t] of this.live) {
      if (!running(sid, t.jobId)) {
        this.live.delete(sid);
        rmSync(this.fileOf(sid), { force: true });
      } else if (t.exp - now < AI_RENEW_S) await this.startTurn(sid, t.jobId);
    }
  }
  /** Tests: the file's current token. */
  read(sessionId: string): string | null {
    try {
      return readFileSync(this.fileOf(sessionId), "utf8").trim();
    } catch {
      return null;
    }
  }
}
