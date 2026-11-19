/**
 * P2-01 (token.md §4.2, 5.6, D-08, ADR-113): the second implementation —
 * an external issuer the owner configured (with the PIN). Its public keys
 * (JWKS) are fetched once when it is configured and cached in the data
 * directory (issuer/jwks.json, 0600); tokens are then verified offline
 * (原则 3): the cache is refetched when its Cache-Control max-age (else an
 * hour) runs out, in the background, and when a token names a `kid` the
 * cache does not have (rotation) — at most once a minute either way. An
 * issuer that cannot be reached leaves the cache in use and marked stale
 * (`daisy access issuer show`). A refetch replaces the whole set: a key
 * the issuer dropped is no longer trusted.
 *
 * Algorithms: EdDSA / Ed25519, ES256, RS256 (RSA ≥ 2048 bits), matched to
 * the key's type — never `none`, never HS* (token.md §2). `typ` must be
 * at+jwt; `iss` exact; `aud` this Daisy's audience at the issuer.
 *
 * Addresses: https. Plain http only on this machine's loopback (127.0.0.1,
 * [::1]) and only when DAISY_ALLOW_HTTP_ISSUER=1 on a machine nobody else
 * has an account on (review M-3: another account could take the port and
 * pose as the issuer) — checked when configuring and before every fetch.
 * No redirects, a 5 s timeout, 256 KB at most.
 *
 * A cache past its lifetime that cannot be refetched is used for at most
 * `jwksMaxStaleMs` more (review M-2); after that every token is refused
 * until the issuer is reachable again.
 *
 * P2-02 uses `exchange` (RFC 8693) with the owner's token, kept in
 * keys/issuer-owner-token (0600).
 */
import { ownerT } from "../../platform/language.ts";
import type { MsgParams } from "../../app/errors.ts";
import type { MessageKey } from "../../../../contracts/src/i18n.ts";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { importJWK, type JWK, type KeyObject } from "jose";
import { TOKEN_LIMITS } from "../../../../contracts/src/limits.ts";
import { readSecretFile } from "../secret-file.ts";
import { ensureKeysDir, exists, writeSecret } from "../keys.ts";
import { readConfigSection, writeConfigSection } from "../config.ts";
import { registerSecret } from "../../observe/redact.ts";
import { peek, verifyAccessToken, type TokenVerifier, type VerifyOptions, type VerifyResult } from "./common.ts";

export const EXTERNAL_ALGORITHMS = ["EdDSA", "Ed25519", "ES256", "RS256"] as const;
const L = TOKEN_LIMITS;

/** What the owner configured (config.json `issuer`). */
export interface IssuerConfig {
  issuer: string;
  metadataUrl: string | null;
  jwksUri: string;
  tokenEndpoint: string | null;
  ownerSubject: string;
  audience: string;
  clientId: string;
  configuredAt: number;
}

/** A public key kept from the JWKS (private members never kept). */
type PublicJwk = JWK & { kid: string; kty: "OKP" | "EC" | "RSA" };

interface JwksCache {
  issuer: string;
  jwksUri: string;
  keys: PublicJwk[];
  fetchedAt: number;
  expiresAt: number;
}

/** An error meant for the owner (configuring) — never carries a token. */
export class IssuerError extends Error {
  /**
   * P6-23b: `message` in the owner's language (it is shown as the
   * issuer's `lastError`); `key` / `params` let a route say it in the
   * request's language.
   */
  constructor(
    readonly key: MessageKey,
    readonly params: MsgParams,
    readonly code: "issuer_invalid" | "issuer_unreachable" | "owner_token_invalid" | "exchange_failed",
  ) {
    super(ownerT().dynamic(key, params));
  }
}
const iss = (k: string) => `server-access.issuer.${k}` as MessageKey;
/** A field's name in the owner's language. */
const whatOf = (k: string) => ownerT().dynamic(`server-access.issuer.what.${k}`);
const failure = (e: any) => (e?.name === "TimeoutError" ? ownerT()("server-access.issuer.timeout") : String(e?.cause?.code || e?.message || e));

/** Review M-3: only the loopback addresses themselves (a `localhost` name can be re-pointed). */
const LOOPBACK = new Set(["127.0.0.1", "[::1]"]);

/** Plain http to a loopback issuer: may it be used now? (review M-3) */
export type HttpPolicy = () => { allowed: boolean; why?: string };
/** DAISY_ALLOW_HTTP_ISSUER=1, and this machine is not shared with other accounts. */
export const httpIssuerPolicy =
  (sharedHost: () => boolean): HttpPolicy =>
  () =>
    process.env.DAISY_ALLOW_HTTP_ISSUER !== "1"
      ? { allowed: false, why: ownerT()("server-access.issuer.httpNeedsEnv") }
      : sharedHost()
        ? {
            allowed: false,
            why: ownerT()("server-access.issuer.httpSharedHost"),
          }
        : { allowed: true };
const NO_HTTP: HttpPolicy = () => ({ allowed: false });

/** An address the owner may name: https, or (by `http`) plain http on loopback. */
export function checkIssuerUrl(raw: string, what: string, isIdentifier = false, http: HttpPolicy = NO_HTTP): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new IssuerError(iss("notUrl"), { what, raw: raw.slice(0, 200) }, "issuer_invalid");
  }
  const loopHttp = u.protocol === "http:" && LOOPBACK.has(u.hostname.toLowerCase());
  if (u.protocol !== "https:" && !loopHttp)
    throw new IssuerError(iss("notHttps"), { what }, "issuer_invalid");
  if (loopHttp) {
    const p = http();
    if (!p.allowed)
      throw new IssuerError(iss("isHttp"), { what, why: p.why ?? ownerT()("server-access.issuer.httpsOnly") }, "issuer_invalid");
  }
  if (u.username || u.password)
    throw new IssuerError(iss("credentials"), { what }, "issuer_invalid");
  if (u.hash || (isIdentifier && u.search))
    throw new IssuerError(iss(isIdentifier ? "queryOrFragment" : "fragment"), { what }, "issuer_invalid");
  return raw;
}

/** RFC 8414 §3.1 (well-known inserted before the path), then OIDC Discovery (appended). */
export function metadataCandidates(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** The issuer's answer as JSON, bounded in time and size; no redirects. */
async function fetchJson(
  url: string,
  http: HttpPolicy,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any; cacheControl: string | null }> {
  // Review M-3: before every request, not only when configuring.
  checkIssuerUrl(url, whatOf("issuerUrl"), false, http);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(L.fetchTimeoutMs),
      headers: { accept: "application/json", ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  } catch (e: any) {
    throw new IssuerError(iss("unreachable"), { origin: new URL(url).origin, error: failure(e) }, "issuer_unreachable");
  }
  const parts: Uint8Array[] = [];
  // Review L-2: a body that breaks off (timeout, reset) is "unreachable" too.
  try {
    const reader = res.body?.getReader();
    let size = 0;
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > L.fetchMaxBytes) {
          await reader.cancel().catch(() => {});
          throw new IssuerError(iss("tooLarge"), { origin: new URL(url).origin, max: L.fetchMaxBytes }, "issuer_unreachable");
        }
        parts.push(value);
      }
  } catch (e: any) {
    if (e instanceof IssuerError) throw e;
    throw new IssuerError(iss("readBroken"), { origin: new URL(url).origin, error: failure(e) }, "issuer_unreachable");
  }
  let json: any = null;
  try {
    json = JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    json = null;
  }
  return { status: res.status, json, cacheControl: res.headers.get("cache-control") };
}

/** How long a JWKS answer may be cached (limits.md §5). */
export function cacheLifetimeMs(cacheControl: string | null): number {
  if (!cacheControl) return L.jwksDefaultMs;
  const cc = cacheControl.toLowerCase();
  if (/(^|[\s,])(no-store|no-cache)($|[\s,=])/.test(cc)) return L.jwksMinMs;
  const m = /(?:^|[\s,])max-age\s*=\s*"?(\d+)/.exec(cc);
  if (!m) return L.jwksDefaultMs;
  return Math.min(L.jwksMaxMs, Math.max(L.jwksMinMs, Number(m[1]) * 1000));
}

const b64len = (s: unknown) => (typeof s === "string" ? Buffer.from(s, "base64url").length : 0);

/** The usable public signing keys of a JWKS (anything else is dropped). */
export function publicKeys(jwks: unknown): PublicJwk[] {
  const keys = (jwks as any)?.keys;
  if (!Array.isArray(keys)) throw new IssuerError(iss("jwksNoKeys"), {}, "issuer_invalid");
  const out: PublicJwk[] = [];
  for (const k of keys) {
    if (!k || typeof k !== "object" || typeof k.kid !== "string" || !k.kid || k.kid.length > 256) continue;
    if (k.use !== undefined && k.use !== "sig") continue;
    if (k.alg !== undefined && !(EXTERNAL_ALGORITHMS as readonly string[]).includes(k.alg)) continue;
    const alg = typeof k.alg === "string" ? { alg: k.alg } : {};
    if (k.kty === "OKP" && k.crv === "Ed25519" && b64len(k.x) === 32)
      out.push({ kty: "OKP", crv: "Ed25519", x: k.x, kid: k.kid, ...alg });
    else if (k.kty === "EC" && k.crv === "P-256" && b64len(k.x) === 32 && b64len(k.y) === 32)
      out.push({ kty: "EC", crv: "P-256", x: k.x, y: k.y, kid: k.kid, ...alg });
    else if (k.kty === "RSA" && typeof k.e === "string" && b64len(k.n) * 8 >= L.rsaMinBits)
      out.push({ kty: "RSA", n: k.n, e: k.e, kid: k.kid, ...alg });
    if (out.length >= L.jwksMaxKeys) break;
  }
  return out;
}

/** Does `alg` fit this key (type, curve, and its own `alg` if it names one)? */
export function algFits(k: PublicJwk, alg: string): boolean {
  const ed = alg === "EdDSA" || alg === "Ed25519";
  const typeOk =
    (k.kty === "OKP" && ed) || (k.kty === "EC" && alg === "ES256") || (k.kty === "RSA" && alg === "RS256");
  if (!typeOk) return false;
  if (k.alg === undefined) return true;
  return k.alg === alg || (ed && (k.alg === "EdDSA" || k.alg === "Ed25519"));
}

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
const cacheFile = (dataDir: string) => join(dataDir, "issuer", "jwks.json");
export const ownerTokenFile = (dataDir: string) => join(dataDir, "keys", "issuer-owner-token");

function readConfig(dataDir: string): IssuerConfig | null {
  const c = readConfigSection(dataDir, "issuer") as Partial<IssuerConfig> | undefined;
  if (!c || typeof c !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  if (!str(c.issuer) || !str(c.jwksUri) || !str(c.ownerSubject) || !str(c.audience) || !str(c.clientId))
    return null;
  return {
    issuer: c.issuer!,
    metadataUrl: str(c.metadataUrl),
    jwksUri: c.jwksUri!,
    tokenEndpoint: str(c.tokenEndpoint),
    ownerSubject: c.ownerSubject!,
    audience: c.audience!,
    clientId: c.clientId!,
    configuredAt: typeof c.configuredAt === "number" ? c.configuredAt : 0,
  };
}

function readCache(dataDir: string, cfg: IssuerConfig): JwksCache | null {
  try {
    const c = JSON.parse(readFileSync(cacheFile(dataDir), "utf8")) as JwksCache;
    // A cache of another issuer or address is not this one's.
    if (c.issuer !== cfg.issuer || c.jwksUri !== cfg.jwksUri) return null;
    return { ...c, keys: publicKeys({ keys: c.keys }) };
  } catch {
    return null;
  }
}

/** What the owner gives when configuring (contracts IssuerSetSchema). */
export interface IssuerInput {
  issuer: string;
  metadataUrl?: string;
  jwksUri?: string;
  tokenEndpoint?: string;
  ownerSubject: string;
  audience?: string;
  clientId?: string;
}

export class ExternalIssuer implements TokenVerifier {
  readonly kind = "external" as const;
  private imported = new Map<string, KeyObject | CryptoKey | Uint8Array>();
  private lastAttempt = 0;
  private inflight: Promise<boolean> | null = null;
  lastError: string | null = null;
  /** Tests: how many times the JWKS was fetched. */
  fetches = 0;
  /** SHA-256 of the stored owner token (review M-4); undefined until read. */
  private ownerHash: string | null | undefined;
  private constructor(
    private dataDir: string,
    readonly config: IssuerConfig,
    private cache: JwksCache | null,
    private http: HttpPolicy,
  ) {}
  get issuer() {
    return this.config.issuer;
  }

  /** The configured issuer, if any (config.json + the cached keys). */
  static load(dataDir: string, http: HttpPolicy = NO_HTTP): ExternalIssuer | null {
    const cfg = readConfig(dataDir);
    return cfg ? new ExternalIssuer(dataDir, cfg, readCache(dataDir, cfg), http) : null;
  }

  /**
   * Configure an issuer: check the addresses, read its metadata, fetch its
   * JWKS — all before anything is saved (an issuer that cannot be reached
   * is not trusted). `defaults`: this Daisy's URN for audience and client id.
   */
  static async configure(
    dataDir: string,
    input: IssuerInput,
    defaults: { urn: string },
    http: HttpPolicy = NO_HTTP,
  ): Promise<ExternalIssuer> {
    const issuer = checkIssuerUrl(input.issuer, whatOf("issuer"), true, http);
    let jwksUri = input.jwksUri ? checkIssuerUrl(input.jwksUri, whatOf("jwksUri"), false, http) : null;
    let tokenEndpoint = input.tokenEndpoint ? checkIssuerUrl(input.tokenEndpoint, whatOf("tokenEndpoint"), false, http) : null;
    let metadataUrl: string | null = input.metadataUrl
      ? checkIssuerUrl(input.metadataUrl, whatOf("metadataUrl"), false, http)
      : null;
    if (!jwksUri || metadataUrl) {
      const tried = metadataUrl ? [metadataUrl] : metadataCandidates(issuer);
      let meta: any = null,
        lastErr: IssuerError | null = null;
      for (const url of tried) {
        try {
          const r = await fetchJson(url, http);
          if (r.status === 200 && r.json && typeof r.json === "object") {
            meta = r.json;
            metadataUrl = url;
            break;
          }
          lastErr = new IssuerError(iss("answered"), { url, status: r.status }, "issuer_unreachable");
        } catch (e) {
          lastErr = e as IssuerError;
        }
      }
      if (!meta) throw lastErr ?? new IssuerError(iss("noMetadata"), {}, "issuer_unreachable");
      // RFC 8414 §3.3: the metadata's issuer is the one configured, exactly.
      if (meta.issuer !== issuer)
        throw new IssuerError(iss("metaIssuerDiffers"), { issuer: String(meta.issuer).slice(0, 200) }, "issuer_invalid");
      if (!jwksUri) {
        if (typeof meta.jwks_uri !== "string") throw new IssuerError(iss("metaNoJwks"), {}, "issuer_invalid");
        jwksUri = checkIssuerUrl(meta.jwks_uri, whatOf("metaJwksUri"), false, http);
      }
      if (!tokenEndpoint && typeof meta.token_endpoint === "string")
        tokenEndpoint = checkIssuerUrl(meta.token_endpoint, whatOf("metaTokenEndpoint"), false, http);
    }
    const config: IssuerConfig = {
      issuer,
      metadataUrl,
      jwksUri,
      tokenEndpoint,
      ownerSubject: input.ownerSubject,
      audience: input.audience ?? defaults.urn,
      // Not the URN itself: a token this Daisy signs for an AI (iss = sub =
      // its URN) must never double as an RFC 7523 client assertion.
      clientId: input.clientId ?? `${defaults.urn}#client`,
      configuredAt: Date.now(),
    };
    const x = new ExternalIssuer(dataDir, config, null, http);
    const cache = await x.fetchJwks();
    if (!cache.keys.length)
      throw new IssuerError(iss("noSigningKey"), {}, "issuer_invalid");
    return x;
  }

  /** Save the configuration and the cache (after `configure`, and the owner token's check). */
  save(): void {
    writeConfigSection(this.dataDir, "issuer", this.config);
    this.persist();
  }

  /** Forget the issuer: configuration, cached keys, the owner's token. */
  static remove(dataDir: string): void {
    writeConfigSection(dataDir, "issuer", undefined);
    rmSync(join(dataDir, "issuer"), { recursive: true, force: true });
    rmSync(ownerTokenFile(dataDir), { force: true });
  }

  private persist() {
    if (!this.cache) return;
    const dir = join(this.dataDir, "issuer");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    writeSecret(cacheFile(this.dataDir), JSON.stringify(this.cache, null, 2) + "\n");
  }

  private async fetchJwks(): Promise<JwksCache> {
    this.fetches++;
    const r = await fetchJson(this.config.jwksUri, this.http);
    if (r.status !== 200) throw new IssuerError(iss("jwksAnswered"), { status: r.status }, "issuer_unreachable");
    const keys = publicKeys(r.json);
    const now = Date.now();
    this.cache = {
      issuer: this.config.issuer,
      jwksUri: this.config.jwksUri,
      keys,
      fetchedAt: now,
      expiresAt: now + cacheLifetimeMs(r.cacheControl),
    };
    this.imported.clear();
    return this.cache;
  }

  /**
   * Refetch the JWKS — at most once a minute unless `force` (the owner's
   * `refresh`). A failure keeps the cached keys (offline, 原则 3).
   */
  refresh(force = false): Promise<boolean> {
    if (this.inflight) return this.inflight;
    if (!force && Date.now() - this.lastAttempt < L.jwksRefetchMs) return Promise.resolve(false);
    this.lastAttempt = Date.now();
    this.inflight = (async () => {
      try {
        await this.fetchJwks();
        this.persist();
        this.lastError = null;
        return true;
      } catch (e: any) {
        this.lastError = String(e?.message || e).slice(0, 300);
        if (force) throw e;
        return false;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Past its max-age (review L-5: whatever the last refetch did); still used. */
  get stale(): boolean {
    return !!this.cache && Date.now() > this.cache.expiresAt;
  }
  /** Past its max-age by more than `jwksMaxStaleMs` (review M-2): no longer used. */
  get expired(): boolean {
    return !!this.cache && Date.now() > this.cache.expiresAt + L.jwksMaxStaleMs;
  }
  /** A refetch is under way. */
  get refreshing(): boolean {
    return this.inflight !== null;
  }

  private find(kid: string): PublicJwk | undefined {
    return this.cache?.keys.find((k) => k.kid === kid);
  }

  private async keyFor(jwk: PublicJwk, alg: string) {
    const id = `${jwk.kid}\n${alg}`;
    let k = this.imported.get(id);
    if (!k) {
      k = await importJWK(jwk, alg);
      this.imported.set(id, k);
    }
    return k;
  }

  /** token.md §4.2 steps 1–4, 6. Who the token makes the caller is the guard's to say. */
  async verify(token: string, o: VerifyOptions): Promise<VerifyResult> {
    const h = peek(token);
    if (!h) return { ok: false, why: "malformed" };
    if (h.iss !== this.config.issuer) return { ok: false, why: "wrong_issuer" };
    if (!(EXTERNAL_ALGORITHMS as readonly string[]).includes(h.alg) || !h.kid)
      return { ok: false, why: "bad_header" };
    // Due for a refetch: in the background — this token is checked with
    // the keys at hand (offline first)…
    if (this.cache && Date.now() > this.cache.expiresAt) {
      // …unless the cache is past its last allowed day (review M-2): then
      // only a fresh set will do (the refetch is still once a minute).
      if (this.expired) {
        await this.refresh();
        if (this.expired) return { ok: false, why: "unknown_key" };
      } else void this.refresh();
    }
    let jwk = this.find(h.kid);
    if (!jwk) {
      // A new kid: the issuer may have rotated (at most once a minute).
      await this.refresh();
      jwk = this.find(h.kid);
    }
    if (!jwk) return { ok: false, why: "unknown_key" };
    if (!algFits(jwk, h.alg)) return { ok: false, why: "bad_header" };
    let key;
    try {
      key = await this.keyFor(jwk, h.alg);
    } catch {
      return { ok: false, why: "unknown_key" };
    }
    const r = await verifyAccessToken(token, key, { ...o, issuer: this.config.issuer, algorithms: [h.alg] });
    // D-38 (stage-2 gate): a token asserting the owner lives at most 24 h
    // (`exp - iat`, no skew; `iat` is required above). Here, once, so every
    // use agrees: a login (the guard, the live socket's first frame), the
    // owner token saved for token exchange, P2-02's check of it. Tokens of
    // others (visitors) are not bound by it; tokens an AI gets for the owner
    // carry `sub` = the owner too and are bound much tighter (1 h, P2-02).
    if (r.ok && r.token.subject === this.config.ownerSubject && r.token.exp - r.token.iat > L.externalOwnerMaxS)
      return { ok: false, why: "too_long" };
    return r;
  }

  // ── the owner's token (subject_token of P2-02's exchange) ────────────
  // Only for token exchange — never a login (review M-4: the guard refuses
  // it as a Bearer token, `isOwnerToken`).
  storeOwnerToken(token: string): void {
    registerSecret(token); // S-1
    ensureKeysDir(this.dataDir);
    writeSecret(ownerTokenFile(this.dataDir), token + "\n");
    this.ownerHash = sha256(token);
  }
  ownerToken(): string | null {
    const f = ownerTokenFile(this.dataDir);
    let t: string | null = null;
    if (exists(f))
      try {
        t = readSecretFile(f, process.platform === "win32" ? undefined : process.getuid?.()).trim() || null;
      } catch {
        t = null;
      }
    if (t) registerSecret(t); // S-1
    this.ownerHash = t ? sha256(t) : null;
    return t;
  }
  /** Is this (a Bearer token's SHA-256) the stored owner token? */
  isOwnerToken(hash: string): boolean {
    if (this.ownerHash === undefined) this.ownerToken();
    return this.ownerHash !== null && this.ownerHash === hash;
  }

  /**
   * RFC 8693 token exchange at the token endpoint, the client proving
   * itself with private_key_jwt (RFC 7523). Answers the issuer's JSON; on
   * an error only its `error` code (sanitised) — never its body.
   */
  async exchange(form: Record<string, string>): Promise<Record<string, unknown>> {
    if (!this.config.tokenEndpoint)
      throw new IssuerError(iss("noTokenEndpoint"), {}, "exchange_failed");
    const r = await fetchJson(this.config.tokenEndpoint, this.http, {
      method: "POST",
      body: new URLSearchParams(form).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    if (r.status !== 200 || !r.json || typeof r.json !== "object") {
      const code = typeof r.json?.error === "string" ? r.json.error.replace(/[^\w.-]/g, "").slice(0, 60) : "";
      throw new IssuerError(iss("tokenEndpointAnswered"), { status: r.status, code: code ? ownerT()("server-access.issuer.errorCode", { code }) : "" }, "exchange_failed");
    }
    return r.json;
  }

  /** For IssuerStatus (no token). */
  status(ownerTokenExp: number | null) {
    const c = this.config;
    return {
      issuer: c.issuer,
      ownerSubject: c.ownerSubject,
      audience: c.audience,
      clientId: c.clientId,
      metadataUrl: c.metadataUrl,
      jwksUri: c.jwksUri,
      tokenEndpoint: c.tokenEndpoint,
      configuredAt: c.configuredAt,
      keys: (this.cache?.keys ?? []).map((k) => ({ kid: k.kid, kty: k.kty, alg: k.alg ?? null })),
      fetchedAt: this.cache?.fetchedAt ?? null,
      expiresAt: this.cache?.expiresAt ?? null,
      expired: this.expired,
      refreshing: this.refreshing,
      stale: this.stale,
      lastError: this.lastError,
      ownerToken: { stored: this.ownerToken() !== null, expiresAt: ownerTokenExp },
    };
  }
}
