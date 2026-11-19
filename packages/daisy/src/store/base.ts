import { DatabaseSync } from "node:sqlite";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { id } from "./ids.ts";
import { log } from "../observe/log.ts";
import { COMMAND_NAME } from "../../../contracts/src/names.ts";
import { openDatabase, restrictToOwner } from "./open.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import { redact, registerSecret } from "../observe/redact.ts";
import {
  currentTrace,
  isTraceId,
  newTraceId,
  type ActorKind,
  type AuditChannel,
  type Entry,
} from "../observe/trace.ts";

/**
 * P1-11 (S-4): what an audit row records besides who / action / target.
 * Unset fields come from the request or call being handled
 * (observe/trace.ts `currentTrace()`); outside any, Daisy itself acting
 * (`system`, `internal`) under a new trace id.
 */
export interface AuditMeta {
  actor?: ActorKind;
  sessionId?: string;
  jobId?: string;
  face?: Entry;
  channel?: AuditChannel;
  route?: string;
  object?: string;
  outcome?: "ok" | "denied" | "error";
  reason?: string;
  status?: number;
  traceId?: string;
  depth?: number;
}
/** `user_id` as the code before P1-11 wrote it → who acted. */
const actorOf = (uid: string): ActorKind =>
  uid === "system"
    ? "system"
    : uid === "anonymous"
      ? "anonymous"
      : uid === "cli"
        ? "cli"
        : uid.startsWith("ai:")
          ? "ai"
          : // P2-01: another's token from the external issuer (guard.ts labels).
            uid.startsWith("visitor:") || uid.startsWith("issuer-ai:")
            ? "visitor"
            : "owner";
/**
 * The database: opening it (store/open.ts; the structure is
 * store/schema.ts), statements, transactions, encryption, the audit log
 * (P1-00: moved from store.ts; `Store` is StoreBase → SessionStore →
 * Store, one file each).
 */
export class StoreBase {
  db: DatabaseSync;
  key: Buffer;
  /** Structure version of the file and of this code (P1-04, ADR-108). */
  schema: { version: number; code: number; newer: boolean; backup?: string };
  private transactionDepth = 0;
  /**
   * P1-04: the one database in the data directory (store/open.ts): the old
   * system's database is refused before anything is written, the
   * directory and files are owner-only, the structure is upgraded in one
   * transaction after a backup. Throws StorageError: start-up stops.
   */
  constructor(public dir: string) {
    const opened = openDatabase(dir);
    this.db = opened.db;
    this.schema = {
      version: opened.to,
      code: SCHEMA_VERSION,
      newer: !!opened.newer,
      ...(opened.backup ? { backup: opened.backup } : {}),
    };
    // P6-15 (ADR-158): what the start's walk found readable by others.
    const pr = opened.perms;
    if (pr?.tightened)
      log.info(
        `Data directory: ${pr.tightened} entries were readable by the group or other accounts (e.g. ${pr.examples.slice(0, 3).join(", ")}); tightened so only you can read and write them`,
      );
    // P6-16 review M1: left loose on purpose (a runner.json others can write).
    if (pr?.left?.length)
      log.warn(
        `${pr.left.join(", ")}: other accounts can write it — left as it is, and Daisy does not use it; check what it says, then chmod go-w`,
      );
    if (pr && (pr.truncated || pr.failed || pr.linked))
      log.warn(
        `Data directory permission check: ${pr.truncated ? `too many entries, only the first ${pr.checked} checked; ` : ""}${pr.failed ? `${pr.failed} could not be read or changed; ` : ""}${pr.linked ? `${pr.linked} files have hard links elsewhere, left unchanged; ` : ""}see ${COMMAND_NAME} doctor`,
      );
    if (opened.newer)
      log.warn(
        `Database structure is version ${opened.to}, newer than this release's (${SCHEMA_VERSION}): structure is additive only, used as it is, not downgraded (ADR-108).`,
      );
    const keyPath = join(dir, "master.key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    restrictToOwner(keyPath);
    this.key = readFileSync(keyPath);
  }
  /**
   * Prepared statements by SQL text (chat latency work): preparing costs
   * more than running most of these point queries. Bounded; PRAGMAs (startup
   * schema checks) are not kept.
   */
  private statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private statement(sql: string) {
    let s = this.statements.get(sql);
    if (s) return s;
    s = this.db.prepare(sql);
    if (!/^\s*PRAGMA/i.test(sql)) {
      if (this.statements.size >= 1000)
        this.statements.delete(this.statements.keys().next().value!);
      this.statements.set(sql, s);
    }
    return s;
  }
  one(sql: string, ...args: any[]): any {
    return this.statement(sql).get(...args);
  }
  all(sql: string, ...args: any[]): any[] {
    return this.statement(sql).all(...args);
  }
  run(sql: string, ...args: any[]) {
    return this.statement(sql).run(...args);
  }
  atomic<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.transactionDepth--;
    }
  }
  /**
   * Whatever is encrypted at rest is a secret (a harness's API key, a
   * login's pasted code, a harness-config operation's arguments): S-1 —
   * registered for redaction both ways.
   */
  encrypt(s: string) {
    registerSecret(s);
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key, iv);
    const bytes = Buffer.concat([c.update(s, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), bytes]).toString("base64");
  }
  decrypt(s: string) {
    const b = Buffer.from(s, "base64"),
      c = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    const plain = Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(
      "utf8",
    );
    registerSecret(plain);
    return plain;
  }
  /**
   * One audit row (S-4): who (`uid` as before: `owner`, `cli`,
   * `ai:<session>`, `anonymous`, `system`), what (`action`), on what
   * (`target`), plus the context — from `meta`, else from the request or
   * call being handled. `target` passes through `redact` (S-1).
   */
  audit(uid: string, action: string, target: string, meta: AuditMeta = {}) {
    const t = currentTrace();
    const rid = id(),
      at = Date.now();
    const actor = meta.actor ?? t?.actor ?? actorOf(uid);
    const text = redact(String(target ?? ""));
    this.atomic(() => {
      this.run(
        "INSERT INTO audit(id,user_id,action,target,created) VALUES(?,?,?,?,?)",
        rid,
        uid,
        action,
        text,
        at,
      );
      this.run(
        "INSERT INTO audit_context(audit_id,trace_id,depth,actor,session_id,job_id,face,channel,route,object,outcome,reason,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        rid,
        isTraceId(meta.traceId) ? meta.traceId : (t?.traceId ?? newTraceId()),
        meta.depth ?? t?.depth ?? 0,
        actor,
        meta.sessionId ?? t?.sessionId ?? (uid.startsWith("ai:") ? uid.slice(3) : null),
        meta.jobId ?? t?.jobId ?? null,
        meta.face ?? t?.face ?? "internal",
        meta.channel ?? t?.channel ?? (actor === "system" ? "system" : "none"),
        meta.route ?? t?.route ?? null,
        meta.object !== undefined ? redact(meta.object).slice(0, 300) : text.slice(0, 300) || null,
        meta.outcome ?? "ok",
        meta.reason ?? null,
        meta.status ?? null,
      );
    });
    return rid;
  }
  close() {
    this.statements.clear();
    this.db.close();
  }
}
