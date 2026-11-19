import type {
  Snapshot,
  Item,
  Approval,
} from "../../../contracts/src/index.ts";
import { SessionStore } from "./sessions.ts";
import { visibleItemsSql } from "./visible.ts";
/**
 * A delta reads every event after the client's cursor; past this
 * many it answers with a tail snapshot instead (a client that was away long).
 */
export const DELTA_EVENTS_MAX = 2000;
/** What a client reads: snapshots, deltas, item pages, events (P1-00: moved from store.ts). */
export class Store extends SessionStore {
  /** `tail` > 0: only the newest `tail` items (`partial` when cut). */
  snapshot(sid: string, tail = 0): Snapshot {
    const snap: Snapshot = this.atomic(() => ({
      session: this.session(sid)!,
      items: (tail
        ? this.all(
            "SELECT data FROM (SELECT rowid r,data FROM items WHERE session_id=? ORDER BY rowid DESC LIMIT ?) ORDER BY r",
            sid,
            tail + 1,
          )
        : this.all(
            "SELECT data FROM items WHERE session_id=? ORDER BY rowid",
            sid,
          )
      ).map((x) => JSON.parse(x.data) as Item),
      approvals: this.approvalsOf(sid),
      cursor: this.cursorOf(sid),
      total: this.itemCount(sid),
      contextKey: this.contextKey(sid),
    }));
    if (tail && snap.items.length > tail) {
      snap.items = snap.items.slice(1);
      return { ...snap, partial: true };
    }
    return snap;
  }
  private approvalsOf(sid: string) {
    return this.all(
      "SELECT data FROM approvals WHERE session_id=? ORDER BY rowid",
      sid,
    ).map((x) => JSON.parse(x.data) as Approval);
  }
  private cursorOf(sid: string): number {
    return this.one(
      "SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE session_id=?",
      sid,
    ).n;
  }
  /**
   * Key of the newest user message that carried a host page context and
   * reached (or will reach) the Agent (fb3 F2): read over the whole
   * conversation, not a client's window. User messages are the
   * `user:<job>` / `input:<id>` items (a primary-key range each).
   */
  contextKey(sid: string): string | null {
    const r = this.one(
      `SELECT k FROM (
         SELECT rowid AS r, json_extract(data,'$.context.key') AS k, json_extract(data,'$.status') AS st
           FROM items WHERE session_id=? AND id>='user:' AND id<'user;'
         UNION ALL
         SELECT rowid AS r, json_extract(data,'$.context.key') AS k, json_extract(data,'$.status') AS st
           FROM items WHERE session_id=? AND id>='input:' AND id<'input;'
       ) WHERE k IS NOT NULL AND COALESCE(st,'') NOT IN ('cancelled','error')
       ORDER BY r DESC LIMIT 1`,
      sid,
      sid,
    );
    return typeof r?.k === "string" ? r.k : null;
  }
  itemCount(sid: string): number {
    return this.one("SELECT COUNT(*) AS n FROM items WHERE session_id=?", sid)
      .n;
  }
  /**
   * What changed since the client's version: the session, all
   * approvals and only the items written after `since` — in the client's
   * window, i.e. from item `from` (its oldest held one) on; none = all.
   * Items keep their order (rowid). null = a delta cannot express it (the
   * cursor is not from this log, the window's first item is gone, or too
   * much changed): answer with a tail snapshot instead.
   */
  delta(sid: string, since: number, from?: string): Snapshot | null {
    return this.atomic(() => {
      const cursor = this.cursorOf(sid);
      if (since > cursor) return null;
      let start = 0;
      if (from) {
        const r = this.one(
          "SELECT rowid AS r FROM items WHERE session_id=? AND id=?",
          sid,
          from,
        );
        if (!r) return null;
        start = Number(r.r);
      }
      let items: Item[] = [];
      if (since < cursor) {
        const n = this.one(
          "SELECT COUNT(*) AS n FROM events WHERE session_id=? AND seq>?",
          sid,
          since,
        ).n;
        if (n > DELTA_EVENTS_MAX) return null;
        const ids = this.all(
          "SELECT DISTINCT json_extract(data,'$.id') AS id FROM events WHERE session_id=? AND seq>? AND type='item'",
          sid,
          since,
        )
          .map((r) => r.id)
          .filter((x): x is string => typeof x === "string");
        if (ids.length)
          items = this.all(
            "SELECT data FROM items WHERE session_id=? AND rowid>=? AND id IN (SELECT value FROM json_each(?)) ORDER BY rowid",
            sid,
            start,
            JSON.stringify(ids),
          ).map((x) => JSON.parse(x.data) as Item);
      }
      return {
        session: this.session(sid)!,
        items,
        approvals: this.approvalsOf(sid),
        cursor,
        total: this.itemCount(sid),
        contextKey: this.contextKey(sid),
        delta: true,
      };
    });
  }
  /**
   * One page of older items: the newest `limit` items before item
   * `before`, oldest first. null = `before` is gone (rewound): the client
   * reloads its window.
   */
  olderItems(
    sid: string,
    before: string,
    limit: number,
  ): { items: Item[]; more: boolean } | null {
    return this.atomic(() => {
      const r = this.one(
        "SELECT rowid AS r FROM items WHERE session_id=? AND id=?",
        sid,
        before,
      );
      if (!r) return null;
      const rows = this.all(
        "SELECT data FROM (SELECT rowid r,data FROM items WHERE session_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?) ORDER BY r",
        sid,
        Number(r.r),
        limit + 1,
      );
      const more = rows.length > limit;
      return {
        items: (more ? rows.slice(1) : rows).map(
          (x) => JSON.parse(x.data) as Item,
        ),
        more,
      };
    });
  }
  /**
   * the newest `limit` visible items (VISIBLE_ITEM_SQL), oldest
   * first; `before` = only those older than that item. null = `before` is
   * gone. `more` = older visible items exist. Uses `items_visible`; the
   * order is reversed here, not by a second SQL sort.
   */
  visibleItems(
    sid: string,
    limit: number,
    before?: string,
  ): { items: Item[]; more: boolean } | null {
    return this.atomic(() => {
      let rows: any[];
      if (before !== undefined) {
        const r = this.one(
          "SELECT rowid AS r FROM items WHERE session_id=? AND id=?",
          sid,
          before,
        );
        if (!r) return null;
        rows = this.all(visibleItemsSql(true), sid, Number(r.r), limit + 1);
      } else rows = this.all(visibleItemsSql(false), sid, limit + 1);
      const more = rows.length > limit;
      return {
        items: (more ? rows.slice(0, limit) : rows)
          .reverse()
          .map((x) => JSON.parse(x.data) as Item),
        more,
      };
    });
  }
  /**
   * a resident's conversation snapshot — the newest `limit`
   * visible items (never a raw `since` delta). `partial` = older visible
   * items exist; `before` = the earliest returned item, for
   * `GET /sessions/:id/items?before=&view=conversation`.
   */
  conversationSnapshot(sid: string, limit: number): Snapshot {
    return this.atomic(() => {
      const page = this.visibleItems(sid, limit)!;
      return {
        session: this.session(sid)!,
        items: page.items,
        approvals: this.approvalsOf(sid),
        cursor: this.cursorOf(sid),
        total: this.itemCount(sid),
        contextKey: this.contextKey(sid),
        view: "conversation" as const,
        before: page.items[0]?.id ?? null,
        ...(page.more ? { partial: true } : {}),
      };
    });
  }
  events(sid: string, after: number) {
    return this.all(
      "SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 500",
      sid,
      after,
    ).map((r) => ({
      id: r.id,
      seq: r.seq,
      sessionId: r.session_id,
      type: r.type,
      data: JSON.parse(r.data),
      createdAt: r.created,
    }));
  }
}
