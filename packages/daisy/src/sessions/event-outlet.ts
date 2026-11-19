/**
 * P2-03 (5.10 「事件出口」, docs/contracts/events.md, ADR-114): the event
 * outlet — what an outside system subscribes to, to learn that a card is
 * waiting for the owner (AI 请求授权, AI 提问, 有人想调用待批准) and when it
 * was resolved.
 *
 * Writing: into the outbox `event_outbox` (store/schema.ts step 4), in the
 * same transaction as the card's own change — the caller is inside its
 * `store.atomic`, and the writer opens one of its own otherwise. One
 * 「出现」 per card while it is open (a card raised again while open is
 * not a second one); its 「了结」 closes it. Titles and display names pass
 * through the redaction layer (S-1); no conversation, tool arguments or
 * credential goes in.
 *
 * Reading: by sequence number (`seq`, AUTOINCREMENT — never reused), a
 * page at a time, optionally waiting (long poll); a snapshot of the open
 * cards with the cursor to read on from. A cursor that cannot be
 * continued — older than what the sweep kept, or beyond the highest
 * sequence ever written (the data was rebuilt) — is answered `reset`: take
 * a snapshot first. Nobody subscribing changes nothing: events are written
 * all the same and swept after the retention (limits.ts EVENT_LIMITS),
 * except an open card's 「出现」, kept until it is resolved.
 */
import { randomUUID } from "node:crypto";
import type { Store } from "../store/index.ts";
import {
  EVENT_LIMITS,
  EVENT_TYPES,
  type DaisyEvent,
  type DaisyEventData,
  type DaisyEventType,
  type EventCardKind,
  type EventResolution,
  type EventsPage,
  type EventsSnapshot,
} from "../../../contracts/src/index.ts";
import {
  currentTrace,
  formatTraceparent,
  isTraceId,
  newSpanId,
  newTraceId,
} from "../observe/trace.ts";
import { redact } from "../observe/redact.ts";

/** A card appeared (its 「出现」 event). */
export interface CardOpened {
  /** Whose card (the owner's user id). */
  uid: string;
  kind: EventCardKind;
  /** The card's stable id: `perm:…`, `block:…`, `ask:…`, `question:…`, `call:…`. */
  cardId: string;
  title: string;
  sessionId?: string;
  /** Milliseconds since the epoch; omitted: the card does not expire. */
  expiresAt?: number;
  /** Display names only (never conversation content). */
  context?: { agentName?: string; callerName?: string };
}
/** A card left pending (its 「了结」 event). */
export interface CardResolved {
  uid: string;
  cardId: string;
  state: EventResolution;
  /** Default: the 「出现」 event's title. */
  title?: string;
}

/**
 * Which kind of card an id is, by its prefix (the ids approvals.ts and
 * stage 4 give their cards): `perm:` a harness permission prompt, `block:`
 * an auto-mode interception the owner may allow, `ask:` an approval the AI
 * raised to its owner — AI 请求授权; `question:` a harness question (asked
 * in the conversation) — AI 提问; `call:` / `wake:` a caller waiting for
 * approval — 有人想调用 (stage 4). Anything else is not an outlet card.
 */
export function cardKindOf(cardId: string): EventCardKind | null {
  const prefix = cardId.slice(0, Math.max(0, cardId.indexOf(":")));
  switch (prefix) {
    case "perm":
    case "block":
    case "ask":
      return "permission";
    case "question":
      return "question";
    case "call":
    case "wake":
      return "invocation";
    default:
      return null;
  }
}

/** How an approval state reads as a resolution (events.md §1 `state`). */
export function resolutionOf(
  state: "approved" | "rejected" | "canceled" | "expired",
): EventResolution {
  return state === "canceled" ? "canceled" : state === "expired" ? "expired" : "handled";
}

/**
 * 点开去哪 (events.md §1 `link`): a path on the local web page. Permission
 * prompts and call requests are answered on 「审批」; a question in its
 * conversation.
 */
export function cardLink(kind: EventCardKind, cardId: string, sessionId?: string): string {
  const card = encodeURIComponent(cardId);
  return kind === "question" && sessionId
    ? `/sessions/${encodeURIComponent(sessionId)}?card=${card}`
    : `/approvals?card=${card}`;
}

const KIND_OF_TYPE = new Map<string, EventCardKind>(
  (Object.keys(EVENT_TYPES) as EventCardKind[]).flatMap((k) => [
    [EVENT_TYPES[k].opened, k],
    [EVENT_TYPES[k].resolved, k],
  ]),
);

const clip = (s: string, n: number) => {
  const t = redact(String(s ?? "")).replace(/\s+/g, " ").trim();
  return [...t].length > n ? [...t].slice(0, n - 1).join("") + "…" : t;
};

export interface EventOutletOptions {
  /** `source`: this Daisy's identity URN (token.md §3). */
  source: () => string;
  /**
   * `data.recipient` for an owner's user id. Standalone: this Daisy's URN
   * (one Daisy, one owner — the key stands for them). P2-01's outside
   * issuer replaces it with the owner's `sub` there.
   */
  recipient?: (uid: string) => string;
  /** Display name of a session's AI (`context.agentName`). */
  agentName?: (sessionId: string) => string | undefined;
  now?: () => number;
}

export type EventsRead = EventsPage | { reset: true };

export function eventOutlet(store: Store, o: EventOutletOptions) {
  const now = o.now ?? Date.now;
  const recipientOf = o.recipient ?? (() => o.source());
  const L = EVENT_LIMITS;

  // ── waiting readers (long poll) ─────────────────────────────────────
  const waiters = new Set<() => void>();
  let polling = 0;
  let closing = false;
  let bumpQueued = false;
  /**
   * Wake the waiting readers once the writer's transaction is over: a
   * write runs synchronously inside `store.atomic`, so by the next turn of
   * the event loop it is committed (or rolled back — a reader that finds
   * nothing just waits on).
   */
  function bump() {
    if (bumpQueued) return;
    bumpQueued = true;
    setImmediate(() => {
      bumpQueued = false;
      for (const w of [...waiters]) w();
    });
  }

  // ── writing ─────────────────────────────────────────────────────────
  /** trace.md §6: the trace of the action that caused it (a new one if none). */
  function traceparent(): string {
    const t = currentTrace();
    return formatTraceparent(t && isTraceId(t.traceId) ? t.traceId : newTraceId(), newSpanId());
  }
  function insert(
    type: DaisyEventType,
    c: { uid: string; cardId: string; sessionId?: string },
    data: Omit<DaisyEventData, "recipient">,
    open: boolean,
  ): number {
    const r = store.run(
      "INSERT INTO event_outbox(id,type,subject,recipient,session_id,time,traceparent,data,open) VALUES(?,?,?,?,?,?,?,?,?)",
      `evt_${randomUUID()}`,
      type,
      c.cardId,
      c.uid,
      c.sessionId || "",
      now(),
      traceparent(),
      JSON.stringify(data),
      Number(open),
    );
    bump();
    return Number(r.lastInsertRowid);
  }
  const openRow = (uid: string, cardId: string) =>
    store.one(
      "SELECT seq,type,session_id,data FROM event_outbox WHERE recipient=? AND subject=? AND open=1 ORDER BY seq DESC LIMIT 1",
      uid,
      cardId,
    );

  /** A card appeared. Its sequence, or null when it is already open. */
  function opened(c: CardOpened): number | null {
    return store.atomic(() => {
      if (openRow(c.uid, c.cardId)) return null;
      const agentName =
        c.context?.agentName ?? (c.sessionId ? o.agentName?.(c.sessionId) : undefined);
      const context = {
        ...(agentName ? { agentName: clip(agentName, 80) } : {}),
        ...(c.context?.callerName ? { callerName: clip(c.context.callerName, 80) } : {}),
      };
      return insert(
        EVENT_TYPES[c.kind].opened,
        c,
        {
          title: clip(c.title, L.titleMax),
          link: cardLink(c.kind, c.cardId, c.sessionId),
          actionRequired: true,
          ...(c.expiresAt ? { expiresAt: new Date(c.expiresAt).toISOString() } : {}),
          ...(Object.keys(context).length ? { context } : {}),
        },
        true,
      );
    });
  }

  /** A card was resolved. Its sequence, or null when it was not open. */
  function resolved(r: CardResolved): number | null {
    return store.atomic(() => {
      const row = openRow(r.uid, r.cardId);
      if (!row) return null;
      const kind = KIND_OF_TYPE.get(row.type);
      if (!kind) return null;
      const before = JSON.parse(row.data) as Omit<DaisyEventData, "recipient">;
      store.run("UPDATE event_outbox SET open=0 WHERE seq=?", row.seq);
      return insert(
        EVENT_TYPES[kind].resolved,
        { uid: r.uid, cardId: r.cardId, sessionId: row.session_id },
        {
          title: r.title ? clip(r.title, L.titleMax) : before.title,
          link: before.link,
          actionRequired: false,
          ...(before.context ? { context: before.context } : {}),
          state: r.state,
        },
        false,
      );
    });
  }

  /**
   * The approval hub's hook (approvals.ts `approvalEvent`): the card's
   * kind from its id, opened while pending, resolved after.
   */
  function card(
    uid: string,
    cardId: string,
    state: "pending" | "approved" | "rejected" | "canceled" | "expired",
    title: string,
    sessionId = "",
  ): number | null {
    const kind = cardKindOf(cardId);
    if (!kind) return null;
    return state === "pending"
      ? opened({ uid, kind, cardId, title, sessionId })
      : resolved({ uid, cardId, state: resolutionOf(state), title });
  }

  // ── reading ─────────────────────────────────────────────────────────
  function render(row: any): DaisyEvent {
    const data = JSON.parse(row.data);
    return {
      specversion: "1.0",
      id: row.id,
      source: o.source(),
      type: row.type,
      subject: row.subject,
      time: new Date(row.time).toISOString(),
      seq: Number(row.seq),
      traceparent: row.traceparent,
      datacontenttype: "application/json",
      data: { recipient: recipientOf(row.recipient), ...data },
    };
  }
  /** The highest sequence ever written (kept by SQLite across deletes). */
  const lastSeq = (): number =>
    Number(store.one("SELECT seq FROM sqlite_sequence WHERE name='event_outbox'")?.seq ?? 0);
  const prunedThrough = (): number =>
    Number(store.one("SELECT pruned_through FROM event_outbox_state WHERE id=1")?.pruned_through ?? 0);

  /** One page after `after` (no waiting). */
  function page(uid: string, after = 0, limit: number = L.pageMax): EventsRead {
    const n = Math.min(L.pageMax, Math.max(1, Math.floor(limit)));
    if (after > lastSeq() || after < prunedThrough()) return { reset: true };
    const rows = store.all(
      "SELECT * FROM event_outbox WHERE recipient=? AND seq>? ORDER BY seq LIMIT ?",
      uid,
      after,
      n + 1,
    );
    const events = rows.slice(0, n).map(render);
    return {
      events,
      cursor: events.length ? events[events.length - 1]!.seq : after,
      hasMore: rows.length > n,
    };
  }

  /**
   * events.md §3: a page, waiting up to `waitS` seconds for one when there
   * is none. Answered at once when an event comes (or the request goes
   * away, or the server closes). Also re-reads every second: a write by
   * another process on the same data (a hand-over) wakes no one
   * here.
   */
  async function read(
    uid: string,
    q: { after?: number; limit?: number; wait?: number },
    signal?: AbortSignal,
  ): Promise<EventsRead> {
    const waitMs = Math.min(L.waitMaxS, Math.max(0, q.wait ?? 0)) * 1000;
    const deadline = now() + waitMs;
    let p = page(uid, q.after ?? 0, q.limit);
    if (waitMs === 0 || "reset" in p || p.events.length) return p;
    if (polling >= L.waitersMax) return p;
    polling++;
    try {
      while (!closing && !signal?.aborted) {
        const left = deadline - now();
        if (left <= 0) break;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(t);
            waiters.delete(done);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          const t = setTimeout(done, Math.min(1000, left));
          waiters.add(done);
          signal?.addEventListener("abort", done, { once: true });
        });
        p = page(uid, q.after ?? 0, q.limit);
        if ("reset" in p || p.events.length) return p;
      }
      return p;
    } finally {
      polling--;
    }
  }

  /** events.md §3: every open card's 「出现」 event, and the cursor to read on from. */
  function snapshot(uid: string): EventsSnapshot {
    // One synchronous read: nothing is written between the two queries.
    const cursor = lastSeq();
    const events = store
      .all("SELECT * FROM event_outbox WHERE recipient=? AND open=1 AND seq<=? ORDER BY seq", uid, cursor)
      .map(render);
    return { events, cursor, snapshot: true };
  }

  // ── retention ───────────────────────────────────────────────────────
  let lastSweep = 0;
  /**
   * Drop what is past the retention (an open card's 「出现」 stays), and
   * remember the highest sequence dropped. Throttled to once per
   * `sweepEveryMs` unless `force`.
   */
  function sweep(at = now(), force = false): number {
    if (!force && at - lastSweep < L.sweepEveryMs) return 0;
    lastSweep = at;
    const cutoff = at - L.retentionMs;
    return store.atomic(() => {
      const top = store.one(
        "SELECT MAX(seq) m, COUNT(*) n FROM event_outbox WHERE open=0 AND time<?",
        cutoff,
      );
      if (!top?.n) return 0;
      store.run("DELETE FROM event_outbox WHERE open=0 AND time<?", cutoff);
      store.run(
        "INSERT INTO event_outbox_state(id,pruned_through) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET pruned_through=MAX(pruned_through,excluded.pruned_through)",
        top.m,
      );
      return Number(top.n);
    });
  }

  /** Server closing: every waiting reader is answered now. */
  function close() {
    closing = true;
    for (const w of [...waiters]) w();
  }

  return { opened, resolved, card, page, read, snapshot, sweep, close, lastSeq };
}
export type EventOutlet = ReturnType<typeof eventOutlet>;
