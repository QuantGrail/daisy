import type {
  Event,
  Session,
  MessageContext,
  CacheCounters,
} from "../../../contracts/src/index.ts";
import {
  parseContextUsage,
  parseQuotaSnapshot,
} from "../../../contracts/src/context-usage.ts";
import { normalizeSessionRecord } from "../../../contracts/src/live.ts";
import { StoreBase } from "./base.ts";
import { id } from "./ids.ts";
import { mergeRelatedTasks } from "./related-tasks.ts";
/**
 * A stored session record as the current code reads it. ADR-152: a record
 * written before the rename has `harborPending` (old item spellings) —
 * read as `schedulerPending`; the next save writes the new name only.
 */
export const parseSessionRecord = (data: string): Session =>
  normalizeSessionRecord(JSON.parse(data));
/** Session records and the event log they are written through (P1-00: moved from store.ts). */
export class SessionStore extends StoreBase {
  session(sid: string): Session | undefined {
    const r = this.one("SELECT data FROM sessions WHERE id=?", sid);
    return r ? parseSessionRecord(r.data) : undefined;
  }
  /** `requestId` is recorded on insert only (idempotent creation, M5). */
  save(s: Session, requestId?: string) {
    this.run(
      "INSERT INTO sessions(id,owner_id,data,request_id) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      s.id,
      s.ownerId,
      JSON.stringify(s),
      requestId ?? null,
    );
  }
  /**
   * Record a message context's task refs on the session (fb3 F3). Call inside
   * the transaction that stores the message, so an idempotent replay (which
   * returns before storing) never merges twice.
   */
  noteContext(sid: string, context: MessageContext | undefined) {
    if (!context?.refs.length) return;
    const s = this.session(sid);
    if (!s) return;
    s.relatedTasks = mergeRelatedTasks(
      s.relatedTasks,
      context.refs,
      Date.now(),
    );
    this.save(s);
  }
  /** The session this owner already created with this requestId, if any. */
  sessionByRequest(ownerId: string, requestId: string): Session | undefined {
    const r = this.one(
      "SELECT data FROM sessions WHERE owner_id=? AND request_id=?",
      ownerId,
      requestId,
    );
    return r ? parseSessionRecord(r.data) : undefined;
  }
  append(
    sid: string,
    type: Event["type"],
    data: any,
    eventId: string = id(),
  ): Event | null {
    return this.atomic(() => {
      if (this.one("SELECT id FROM events WHERE id=?", eventId)) return null;
      const s = this.session(sid);
      if (!s) throw Error("Session missing");
      const now = Date.now();
      // the newest context usage / quota, on the session itself.
      if (type === "item" && data?.category === "usage")
        this.noteUsage(s, data);
      const r = this.run(
        "INSERT INTO events(id,session_id,type,data,created) VALUES(?,?,?,?,?)",
        eventId,
        sid,
        type,
        JSON.stringify(data),
        now,
      );
      if (type === "item")
        this.run(
          "INSERT INTO items(id,session_id,data) VALUES(?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET data=excluded.data",
          data.id,
          sid,
          JSON.stringify(data),
        );
      if (type === "status") s.status = data.status;
      if (type === "native") {
        s.nativeId = data.nativeId;
        if (data.contextDelivered === true) s.contextDelivered = true;
        // this Codex thread was started with Daisy's tools.
        // P4N-3: …and which ones (a thread keeps that set for good).
        const toolNames = (x: unknown) =>
          Array.isArray(x)
            ? x
                .filter((n): n is string => typeof n === "string" && /^[a-z_]{1,40}$/.test(n))
                .slice(0, 64)
            : null;
        if (typeof data.nativeTools === "number" && data.nativeId) {
          const names = toolNames(data.nativeToolNames);
          s.nativeTools = {
            thread: data.nativeId,
            version: data.nativeTools,
            ...(names ? { names } : {}),
          };
        }
        // P4N-3: the owner was told this thread lacks these tools.
        const noticed = toolNames(data.nativeToolsNoticed);
        if (noticed && data.nativeId)
          s.nativeToolsNotice = { thread: data.nativeId, names: noticed };
        // this native session / thread has Daisy's layered prompt
        // in its system layer (which text; did it hold the static rules).
        if (
          data.nativeId &&
          data.nativeGuide &&
          typeof data.nativeGuide.sha256 === "string" &&
          /^[0-9a-f]{64}$/.test(data.nativeGuide.sha256)
        )
          s.nativeGuide = {
            thread: data.nativeId,
            sha256: data.nativeGuide.sha256,
            staticRules: data.nativeGuide.staticRules === true,
            ...(["record", "inject", "fresh"].includes(data.nativeGuide.via)
              ? { via: data.nativeGuide.via }
              : {}),
            at: now,
          };
        // …or no longer has it for sure (a Claude session resumed with the
        // engine's own recorded prompt): each turn carries the full note
        // again and the page says so.
        else if (
          data.nativeId &&
          data.nativeGuide?.clear === true &&
          s.nativeGuide?.thread === data.nativeId
        )
          delete s.nativeGuide;
        // what the Agent reported it runs with.
        if (data.model || data.effort || data.serviceTier)
          s.runtime = {
            ...(data.model ? { model: data.model } : {}),
            ...(data.effort ? { effort: data.effort } : {}),
            ...(data.serviceTier ? { serviceTier: data.serviceTier } : {}),
            // what the permission mode really is now.
            ...(typeof data.permissionMode === "string" && data.permissionMode
              ? { permissionMode: data.permissionMode.slice(0, 40) }
              : {}),
            at: now,
          };
      }
      if (type === "live") s.live = data;
      if (type === "approval")
        this.run(
          "INSERT INTO approvals(id,session_id,job_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
          data.id,
          sid,
          data.jobId,
          JSON.stringify(data),
        );
      s.updatedAt = now;
      this.save(s);
      return {
        id: eventId,
        seq: Number(r.lastInsertRowid),
        sessionId: sid,
        type,
        data,
        createdAt: now,
      };
    });
  }
  /**
   * A `<jid>:context` (v1) or `<jid>:quota` item is being written:
   * keep the newest on the session, whatever window a client loads, and the
   * conversation's cache counters — this item's previous version taken out
   * first, so a replay or retry never counts twice.
   */
  private noteUsage(s: Session, item: any) {
    const itemId = String(item.id || "");
    if (itemId.endsWith(":quota")) {
      const q = parseQuotaSnapshot(item.input);
      if (q && (!s.quota || q.fetchedAt >= s.quota.fetchedAt)) s.quota = q;
      return;
    }
    if (!itemId.endsWith(":context")) return;
    const usage = parseContextUsage(item.input);
    if (!usage) return; // an older Runner: the item alone, as before
    const add = (a: CacheCounters | null, b: CacheCounters | null, sign = 1) =>
      !b
        ? a
        : {
            prompt: Math.max(0, (a?.prompt ?? 0) + sign * b.prompt),
            read: Math.max(0, (a?.read ?? 0) + sign * b.read),
            write:
              b.write === null && a?.write == null
                ? null
                : Math.max(0, (a?.write ?? 0) + sign * (b.write ?? 0)),
          };
    const before = this.one(
      "SELECT data FROM items WHERE session_id=? AND id=?",
      s.id,
      itemId,
    );
    const prev = before
      ? parseContextUsage(JSON.parse(before.data).input)
      : null;
    // `cache: null` = no new count for this job (a process restarted
    // between turns reports into the last job's item): the job keeps the
    // counters it had, in the stored item too (review S1).
    if (usage.cache === null && prev?.cache) {
      usage.cache = prev.cache;
      item.input = { ...item.input, cache: prev.cache };
    }
    if (usage.lastCompact === undefined && prev?.lastCompact) {
      usage.lastCompact = prev.lastCompact;
      item.input = { ...item.input, lastCompact: prev.lastCompact };
    }
    let total: CacheCounters | null;
    if (s.context && "cacheSession" in s.context)
      total = add(
        add(s.context.cacheSession, prev?.cache ?? null, -1),
        usage.cache,
      );
    else {
      // First v1 item here: count every earlier one too.
      total = usage.cache;
      for (const r of this.all(
        "SELECT data FROM items WHERE session_id=? AND id LIKE '%:context' AND id!=?",
        s.id,
        itemId,
      ))
        total = add(
          total,
          parseContextUsage(JSON.parse(r.data).input)?.cache ?? null,
        );
    }
    const newest = !s.context || usage.updatedAt >= s.context.updatedAt;
    s.context = {
      ...(newest ? usage : s.context!),
      itemId: newest ? itemId : s.context!.itemId,
      cacheSession: total,
    };
  }
}
