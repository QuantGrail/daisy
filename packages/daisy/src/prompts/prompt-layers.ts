import { agentShortName, isAcpAgent } from "../../../contracts/src/acp-harnesses.ts";
import type { RunnerPort } from "../app/runner-port.ts";
import { OWNER_ID, ownerUser } from "../access/owner.ts";
import { clearInterval, setInterval } from "node:timers";
import { z } from "zod";
import type { Session, User } from "../../../contracts/src/index.ts";
import {
  GUIDE_LIMITS,
  ORG_READ_REASON_KEY,
  orgReadReason,
  PROMPT_OPTIONAL,
  PROMPT_OPTIONAL_DEFAULT,
  PROMPT_OPTIONAL_TITLE_KEY,
  composeGuide,
  coreKnowsInjection,
  INJECT_MARK,
  jobGuide,
  looksLikeOrgCore,
  type ComposedGuide,
  type JobGuide,
  type MyPromptView,
  type OrgGuideRecord,
  type PromptLayerAdminView,
  type PromptLayerSettings,
  type PromptOptional,
  type SessionPromptExtra,
  type SessionPromptView,
  type UserPromptPrefs,
} from "../../../contracts/src/guide.ts";
import { forgedMarker } from "../../../contracts/src/resident-prompt.ts";
import { promptRefreshAt } from "../../../contracts/src/agent-capabilities.ts";
import { toolNamesFor } from "../../../contracts/src/native-tools.ts";
import { residentHeld } from "../../../contracts/src/scheduler.ts";
import { hash, id, type Store } from "../store/index.ts";
import { serve } from "../app/serve.ts";
import { api } from "../../../contracts/src/api/index.ts";
import {
  PROMPT_APPLY_LIMIT,
  PROMPT_APPLY_LIMIT_MAX,
} from "../../../contracts/src/api/prompts.ts";
import { log } from "../observe/log.ts";
import type { OrgCoreSource } from "../plugins/server.ts";
import type { MessageKey, Translate } from "../../../contracts/src/i18n.ts";
import { promptT, sessionT } from "../../../contracts/src/prompt-i18n.ts";
import { LocalizedError, requestT } from "../app/language.ts";
import { HttpError } from "../app/errors.ts";
import { newSessionLang } from "./lang.ts";
import { namedFor, nameFor } from "../platform/default-names.ts";
/**
 * Daisy's layered prompt, control-plane side.
 *
 * - **Off is off.** While the switch (`mode`) is off nothing here acts:
 *   the org document is not read, a Runner is not asked to read or report (and a
 *   report that still arrives is answered 204 and dropped), nothing is
 *   stored, logged, audited or notified.
 * - **Whose word the org core is.** The control plane reads the L1
 *   document a plugin names (hook 1, `deps.orgCore`) itself where it can
 *   (`deps.readCore`: the plugin's read as the control plane's own
 *   account) — that text is the
 *   authority, and a Runner's report that differs is refused, logged and
 *   shown to admins. Its last checked copy goes on being used when it can
 *   no longer read (said to be out of date after 24 hours) — a Runner's
 *   unchecked word never replaces a text the control plane checked. Only
 *   where it never read L1 at all (its account has no access to it)
 *   is a Runner's report used — and then only a text whose SHA-256 is the
 *   one an admin wrote into the settings (`orgExpected`: computed by her,
 *   independently, from L1). Nothing a holder of a node token can send
 *   changes what is used: a text with another hash, an empty or an
 *   invalid report is not adopted and displaces nothing; the last text
 *   that matched goes on being used until the admin changes the expected
 *   hash. That source is said as such everywhere (「Runner 上报，未经控制
 *   面核对」) — never as 「L1 锁定」. Either way a text is adopted only if
 *   it is recognisably a core (a 「## 规则」 part and a red lines section).
 * - `guideFor(session)` composes the four layers (contracts `composeGuide`)
 *   for a job — only when the layers are on for that session (a switch:
 *   off / a list of sessions and people / all; off by default; `all` only
 *   with a core that knows the 「Harbor 注入」 convention) and its node's
 *   Runner declared `promptLayers`. Otherwise nothing is sent and
 *   everything is as before.
 * - A person's defaults for her ordinary sessions (`/api/me/prompt`) and
 *   one session's own additions (`/api/sessions/:id/prompt/extra`). Hers
 *   alone to read and write; every change is logged (`prompt_edit_log`,
 *   kept as an audit trail after the session is deleted).
 * - `GET /api/sessions/:id/prompt`: what that session really gets, layer by
 *   layer — its owner only.
 * - 「立即生效」: a changed text reaches an existing Claude conversation at
 *   its next compaction (the engine keeps the system prompt it recorded) —
 *   so applying now is one `/compact` per conversation, queued one at a
 *   time per node, by its owner for one session or by an admin for all.
 */
/**
 * P6-24 (ADR-159): every word here is a language pack's (`prompt-admin.*`).
 * An answer to a request is in the request's language (`requestT`); an
 * error is a `LocalizedError` (its `code` stable, its text in the
 * request's language). Words stored for later display — a node's
 * problem, the org core log, the 「立即生效」 queue's notes, the edit
 * history — are rendered when written: in the request's language when a
 * person's request writes them, else (a Runner's report, a timer) in the
 * owner's language (`newSessionLang`: the setting, else the system's).
 * Log lines are English.
 */
const fail = (
  statusCode: number,
  code: string,
  key: MessageKey,
  params: Record<string, string | number> = {},
): never => {
  throw new LocalizedError(statusCode, code, key, params);
};
/**
 * A refusal on the Runner's own port (its error handler sends `message`
 * as it is): said in `t`, the owner's language.
 */
const refuse = (statusCode: number, code: string, text: string): never => {
  throw new HttpError(statusCode, text, code);
};
/** Words to be said in some language (the caller's translator decides). */
type Words = (t: Translate) => string;
const DEFAULTS: PromptLayerSettings = {
  orgExpected: "",
  mode: "off",
  sessions: [],
  users: [],
  staticRules: true,
  claudeFresh: false,
  freshList: [],
  orgRead: true,
  epoch: 0,
};
const OrgReportSchema = z.object({
  docId: z.string().regex(/^[A-Z]{2,8}-[0-9a-f]{6,32}$/),
  version: z.number().int().min(0).max(1e9),
  sha256: z.string().max(64),
  // Sized below, in bytes.
  body: z.string().max(GUIDE_LIMITS.orgBytesMax),
  fetchedAt: z.number().int().min(0),
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  // Why its read did not work: a code (`ORG_READ_REASONS`), mapped to
  // fixed words — an unknown one is "other".
  reason: z.unknown().optional(),
  // Free text of an older Runner: taken off the request and dropped —
  // never stored, returned or shown (it would be the one way for a holder
  // of a node token to put words, or a hash, in front of an admin).
  problem: z.unknown().optional(),
});
/** How often the control plane reads L1 itself. */
export const ORG_CORE_MS = 10 * 60_000;
/** Its own copy is the authority this long after its last good read. */
export const ORG_AUTHORITY_MS = 24 * 3600_000;
/** A node's reports: at most this many log lines an hour (the rest are only counted)… */
export const ORG_LOG_PER_HOUR = 12;
/**
 * …except a change of whether its text is the one in use (it matches ↔
 * it does not): always written, whatever else filled the log. (Its own,
 * much larger ceiling — a node flipping all the time cannot grow the log
 * without bound; the line at the ceiling says so.)
 */
export const ORG_STATE_LOG_PER_HOUR = 120;
/**
 * 「有节点上报的启动核心与期望哈希不符」: one notification for all nodes,
 * and while some node goes on not matching at most one in this long…
 */
export const ORG_NOTIFY_GAP_MS = 6 * 3600_000;
/**
 * …armed again once every node matches — but never two within this long
 * (a node flipping between the two states cannot turn it into a stream).
 */
export const ORG_NOTIFY_MIN_MS = 3600_000;
/** Without the control plane's own read: at most this many people on the pilot list. */
export const PILOT_MAX = 5;
/**
 * How an admin computes the expected hash herself: the plugin's command
 * prints the document's body byte for byte — the same bytes a Runner reads
 * and both sides hash as UTF-8. P4-13: the command is the plugin's (hook 1,
 * `orgCore.rawCommand`); none enabled — there is no document to hash.
 */
export function orgVerifyHint(t: Translate, orgCore?: OrgCoreSource): string {
  return orgCore
    ? `${orgCore.rawCommand} | sha256sum`
    : t("prompt-admin.verifyHint.none");
}
/** 「立即生效」: an estimate's token is good for this long, once. */
export const APPLY_TOKEN_MS = 5 * 60_000;
/** Only nodes heard from this recently count (the reference core, alerts). */
export const ORG_NODE_ACTIVE_MS = 24 * 3600_000;
/** 「立即生效」: at most this many conversations per request (the most recently used). */
// P1-06: defined with the route (packages/contracts/src/api/prompts.ts).
export const APPLY_LIMIT = PROMPT_APPLY_LIMIT;
export const APPLY_LIMIT_MAX = PROMPT_APPLY_LIMIT_MAX;
/** 「立即生效」: one compaction per node at a time, this far apart. */
export const APPLY_GAP_MS = 30_000;
/** …given up after this long without an idle moment. */
export const APPLY_WAIT_MS = 24 * 3600_000;
/** …and only conversations used this recently (the rest take it when they next compact). */
export const APPLY_RECENT_MS = 7 * 86_400_000;
export interface PromptLayerDeps {
  user: (req: any) => User;
  /** A session the caller may read (its owner, or an admin where allowed). */
  session: (req: any, sid: string) => Session;
  /** The Runner's node (P1-02: the in-process Runner's own). */
  node: (req: any) => { id: string };
  /** P1-02: the in-process Runner's calls (were /api/runner/*). */
  runner: RunnerPort;
  touched: (sid: string) => void;
  /**
   * The control plane's collaboration features (P1-01: none since the 群聊
   * CLI is gone; stage 4's A2A tools may add theirs).
   */
  features: string[];
  /** Daisy's tools of a session, for the read-only view (`caps`: its Runner's). */
  tools?: (s: Session, caps: any) => { name: string; description: string }[];
  /**
   * Which L1 document the org layer is, and how an admin prints it
   * (hook 1's `orgCore`, P4-13). Absent: no plugin gives one — nothing is
   * read or reported, the org layer is the one 「暂时取不到」 line.
   */
  orgCore?: OrgCoreSource;
  /**
   * The control plane's own read of an L1 document (the plugin's read as
   * its service account) → `{ path, meta, body }`. Absent: it has no way
   * to the organisation's platform (tests, a host without it). P1-10:
   * given by an enabled plugin (hook 1, plugins.ts); none enabled → absent.
   */
  readCore?: (docId: string) => Promise<any>;
  coreMs?: number;
  /** Timers act only on the leading process. */
  leading?: () => boolean;
  applyGapMs?: number;
  /** People on the pilot list while the control plane cannot read L1 itself (default 5). */
  pilotMax?: number;
  /** An alert pushed to a person through the notification channel. */
  notify?: (userId: string, key: string, title: string, subject: string) => void;
  /**
   * End a job the node's Runner has not claimed yet (the switch goes off:
   * a compaction still in line is taken back). false: it was not in line
   * any more.
   */
  withdrawQueued?: (jobId: string, why: string) => boolean;
  /** P6-24: the data directory (the owner's language setting, drop-in packs). */
  dataDir?: string;
}
export function promptLayerRoutes(app: any, store: Store, deps: PromptLayerDeps) {
  // P4-13: the org document is a plugin's (hook 1); none → "" (no row,
  // no report and no read ever matches it).
  const ORG_DOC_ID = deps.orgCore?.docId ?? "";
  const verifyHint = (t: Translate) => orgVerifyHint(t, deps.orgCore);
  /** The owner's language: words stored without a request in scope. */
  const ownerT = (): Translate => promptT(newSessionLang(deps.dataDir));
  /** The language a request is answered in. */
  const reqT = (req: any): Translate => requestT(req, deps.dataDir);
  // Tables: node_org_guides, org_core, org_guide_log, org_trusted,
  // user_prompt_prefs, prompt_edit_log, prompt_layer_settings,
  // prompt_apply_queue, prompt_apply_tokens (store/schema.ts).
  /**
   * `node_org_guides`, one row per node — only what it last reported:
   * `level`, `version`, `fetched_at` and `self_reason` are the node's
   * own claims (shown as such, used for nothing a session gets);
   * `reported_at` and `problem` are ours; `sha256`, `body` are of its
   * last text that is a core, and `accepted` says whether that text is
   * the one in use — equal to the control plane's, or to the expected
   * hash. Nothing here is what sessions get: see `org_trusted`.
   * (`pin_*` / `pending_*` of an earlier design are not used.)
   * `self_reason` is a code of `ORG_READ_REASONS` (never free text).
   *
   * `org_guide_log.kind` — 0: a report · 1: a change of whether a node's
   * text is the one in use · 2: an act of a person or of the control plane
   * itself.
   *
   * `org_trusted`: the text in use where the control plane never read L1:
   * the last one reported by any node whose SHA-256 was the expected hash.
   * Replaced only by another text that matches the expected hash.
   * (`version`: not written — a text only a Runner reported has no version
   * the control plane knows; its hash names it.)
   *
   * `prompt_apply_queue.batch` — 「立即生效」 of an admin: the batch a
   * queued conversation belongs to (NULL: asked for by its owner).
   */
  const settings = (): PromptLayerSettings => {
    try {
      const row = store.one(
        "SELECT value FROM prompt_layer_settings WHERE key='config'",
      );
      const v = row ? JSON.parse(row.value) : {};
      const list = (x: unknown) =>
        Array.isArray(x) ? x.filter((y) => typeof y === "string") : [];
      return {
        ...DEFAULTS,
        ...v,
        sessions: list(v.sessions),
        users: list(v.users),
        freshList: list(v.freshList),
        epoch: Number.isInteger(v.epoch) ? v.epoch : 0,
        orgExpected:
          typeof v.orgExpected === "string" && /^[0-9a-f]{64}$/.test(v.orgExpected)
            ? v.orgExpected
            : "",
      };
    } catch {
      return { ...DEFAULTS };
    }
  };
  const saveSettings = (v: PromptLayerSettings) =>
    store.run(
      "INSERT INTO prompt_layer_settings(key,value) VALUES('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify(v),
    );
  // P1-03: one owner (the system account that runs this Daisy).
  const username = (uid: string) =>
    uid === OWNER_ID ? ownerUser().username : uid;
  const caps = (nodeId: string): any => {
    try {
      return JSON.parse(
        store.one("SELECT capabilities FROM nodes WHERE id=?", nodeId)
          ?.capabilities || "{}",
      );
    } catch {
      return {};
    }
  };
  // P6-28: Daisy's own node name in the reader's language.
  const nodeLabel = (nodeId: string, t: Translate) => {
    const n = store.one("SELECT label FROM nodes WHERE id=?", nodeId);
    return n ? nameFor("node", n.label, t) : nodeId;
  };
  // ── the org core: whose word it is ───────────────────────────────────
  /** A change of the core's text (or a refusal): who, when, before → after. */
  const logCore = (
    source: "control-plane" | "runner",
    nodeId: string | null,
    r: { version: number; level: number },
    before: string,
    after: string,
    accepted: boolean,
    words: string,
    /**
     * "report": one of a Runner's reports — not written again when it is
     * what this node's last line says, and at most `ORG_LOG_PER_HOUR` an
     * hour. "state": whether this node's text is the one in use changed —
     * always written, whatever filled the hour (its own, large ceiling).
     * "act": a person's act, or the control plane's own read — always.
     */
    kind: "report" | "state" | "act" = "report",
  ): boolean => {
    const hour = (k: number) =>
      store.one(
        "SELECT COUNT(*) n FROM org_guide_log WHERE node_id=? AND kind=? AND at>?",
        nodeId,
        k,
        Date.now() - 3600_000,
      ).n as number;
    const dropped = () =>
      store.run(
        "UPDATE node_org_guides SET log_dropped=log_dropped+1 WHERE node_id=?",
        nodeId,
      );
    if (nodeId && kind === "report") {
      const last = store.one(
        "SELECT after_sha,accepted FROM org_guide_log WHERE node_id=? ORDER BY at DESC, rowid DESC LIMIT 1",
        nodeId,
      );
      if (last && last.after_sha === after && !!last.accepted === accepted)
        return false;
      if (hour(0) >= ORG_LOG_PER_HOUR) {
        dropped();
        return false;
      }
    }
    if (nodeId && kind === "state") {
      const n = hour(1);
      if (n > ORG_STATE_LOG_PER_HOUR) {
        dropped();
        return false;
      }
      if (n === ORG_STATE_LOG_PER_HOUR)
        words = ownerT()("prompt-admin.log.stateCeiling", { n, words });
    }
    store.run(
      "INSERT INTO org_guide_log(id,at,source,node_id,doc_id,version,level,before_sha,after_sha,accepted,note,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      id(),
      Date.now(),
      source,
      nodeId,
      ORG_DOC_ID,
      r.version,
      r.level,
      before,
      after,
      accepted ? 1 : 0,
      words.slice(0, 400),
      kind === "report" ? 0 : kind === "state" ? 1 : 2,
    );
    store.audit(
      nodeId ? `runner:${nodeId}` : "control-plane",
      accepted ? "prompt.org.change" : "prompt.org.rejected",
      `${nodeId || "control-plane"}:${before.slice(0, 12) || "-"}->${after.slice(0, 12) || "-"}`,
    );
    if (!accepted)
      log.warn(
        `[prompt-layers] org core report not adopted: node ${nodeId}: ${words}`,
      );
    return true;
  };
  const ownRow = () =>
    store.one("SELECT * FROM org_core WHERE doc_id=?", ORG_DOC_ID);
  /** The control plane's own copy, while its last good read is recent. */
  const authority = (now = Date.now()): OrgGuideRecord | null => {
    const r = ownRow();
    if (!r?.body || now - r.ok_at > ORG_AUTHORITY_MS) return null;
    return {
      docId: ORG_DOC_ID,
      version: r.version,
      sha256: r.sha256,
      body: r.body,
      fetchedAt: r.ok_at,
      level: now - r.ok_at <= 2 * (deps.coreMs ?? ORG_CORE_MS) ? 1 : 2,
      source: "control-plane",
    };
  };
  let reading: Promise<void> | null = null;
  /** Set on shutdown: a read still under way must not write to a closed store. */
  let stopped = false;
  /**
   * Read L1 as the control plane itself. Never throws. Not while the
   * switch is off (`force`: an admin is switching it on right now).
   */
  const readOwn = (force = false): Promise<void> => {
    if (!deps.readCore || !ORG_DOC_ID || stopped) return Promise.resolve();
    if (!force && settings().mode === "off") return Promise.resolve();
    if (reading) return reading;
    reading = (async () => {
      const now = Date.now();
      let problem = "";
      // Stored and shown to admins later: the owner's language.
      const t = ownerT();
      try {
        const d = await deps.readCore!(ORG_DOC_ID);
        if (stopped) return;
        const body = d?.body;
        if (d?.meta?.status !== "active")
          problem = t("prompt-admin.read.status", {
            status: String(d?.meta?.status || t("prompt-admin.read.statusUnknown")).slice(0, 40),
          });
        else if (typeof body !== "string" || !body.trim())
          problem = t("prompt-admin.read.empty");
        else if (Buffer.byteLength(body, "utf8") > GUIDE_LIMITS.orgBytesMax)
          problem = t("prompt-admin.read.tooLarge");
        else if (!looksLikeOrgCore(body))
          problem = t("prompt-admin.read.notCore");
        else {
          const v = Number(d.meta?.version);
          const version = Number.isInteger(v) && v > 0 ? v : 0;
          const sha = hash(body),
            old = ownRow();
          store.run(
            `INSERT INTO org_core(doc_id,version,sha256,body,ok_at,checked_at,problem) VALUES(?,?,?,?,?,?,NULL)
             ON CONFLICT(doc_id) DO UPDATE SET version=excluded.version,sha256=excluded.sha256,body=excluded.body,
               ok_at=excluded.ok_at,checked_at=excluded.checked_at,problem=NULL`,
            ORG_DOC_ID,
            version,
            sha,
            body,
            now,
            now,
          );
          if ((old?.sha256 || "") !== sha)
            logCore(
              "control-plane",
              null,
              { version, level: 1 },
              old?.sha256 || "",
              sha,
              true,
              t(old?.sha256 ? "prompt-admin.log.ownNew" : "prompt-admin.log.ownFirst"),
            );
          return;
        }
      } catch (e: any) {
        problem = t("prompt-admin.read.unreachable", { error: String(e?.message || e).slice(0, 160) });
      }
      if (stopped) return;
      if (ownRow())
        store.run(
          "UPDATE org_core SET checked_at=?,problem=? WHERE doc_id=?",
          now,
          problem,
          ORG_DOC_ID,
        );
      else
        store.run(
          "INSERT INTO org_core(doc_id,version,sha256,body,ok_at,checked_at,problem) VALUES(?,0,'','',0,?,?)",
          ORG_DOC_ID,
          now,
          problem,
        );
    })()
      .catch((e: any) => {
        if (!stopped) log.error("org core read:", e?.message);
      })
      .finally(() => {
        reading = null;
      });
    return reading;
  };
  const nodeRow = (nodeId: string) =>
    store.one("SELECT * FROM node_org_guides WHERE node_id=?", nodeId);
  const trustedRow = () =>
    store.one("SELECT * FROM org_trusted WHERE doc_id=?", ORG_DOC_ID);
  /**
   * The text in use where the control plane never read L1: the one whose
   * SHA-256 is the expected hash an admin typed in — the last such text
   * any node reported. (Which node reported it does not matter: it is
   * that text, byte for byte.) Nothing a node sends afterwards changes
   * it; only the admin's expected hash decides.
   */
  const trustedOrg = (nodeId: string): OrgGuideRecord | null => {
    const expected = settings().orgExpected,
      t = trustedRow(),
      r = nodeRow(nodeId);
    if (expected && t?.body && t.sha256 === expected)
      return {
        docId: ORG_DOC_ID,
        // Neither a version nor a level: those would be a node's word. The
        // record is the same whatever any node says of itself — so is the
        // text composed from it (its head line names it by its hash).
        version: 0,
        sha256: t.sha256,
        body: t.body,
        fetchedAt: t.at,
        level: 2,
        source: "runner",
      };
    // Nothing that matches (or no expected hash yet): the one line.
    return r
      ? {
          docId: ORG_DOC_ID,
          version: 0,
          sha256: "",
          body: "",
          fetchedAt: 0,
          level: 4,
          source: "runner",
        }
      : null;
  };
  /** A text whose hash is the expected one becomes (or stays) the text in use. */
  const trust = (body: string, nodeId: string | null) => {
    const sha = hash(body);
    // The same text: nothing changes — not when, not by whom.
    if (trustedRow()?.sha256 === sha) return false;
    store.run(
      `INSERT INTO org_trusted(doc_id,sha256,body,version,at,node_id) VALUES(?,?,?,0,?,?)
       ON CONFLICT(doc_id) DO UPDATE SET sha256=excluded.sha256,body=excluded.body,version=0,at=excluded.at,node_id=excluded.node_id`,
      ORG_DOC_ID,
      sha,
      body,
      Date.now(),
      nodeId,
    );
    return true;
  };
  /** The control plane's last checked copy, however old (`expired` past a day). */
  const ownCopy = (now = Date.now()): OrgGuideRecord | null => {
    const r = ownRow();
    if (!r?.body) return null;
    return {
      docId: ORG_DOC_ID,
      version: r.version,
      sha256: r.sha256,
      body: r.body,
      fetchedAt: r.ok_at,
      level: now - r.ok_at <= 2 * (deps.coreMs ?? ORG_CORE_MS) ? 1 : 2,
      source: "control-plane",
      ...(now - r.ok_at > ORG_AUTHORITY_MS ? { expired: true } : {}),
    };
  };
  /**
   * The core a session of `nodeId` gets: what the control plane read
   * itself — now, or its last checked copy (out of date after a day, and
   * said so); only where it never read L1, the reported text whose hash
   * is the admin's expected hash; else nothing.
   */
  const orgOf = (nodeId: string): OrgGuideRecord | null =>
    ownCopy() ?? trustedOrg(nodeId);
  const prefsOf = (uid: string): UserPromptPrefs => {
    try {
      const r = store.one(
        "SELECT body FROM user_prompt_prefs WHERE user_id=?",
        uid,
      );
      const v = r ? JSON.parse(r.body) : {};
      return {
        note: typeof v.note === "string" ? v.note : "",
        sections: Object.fromEntries(
          PROMPT_OPTIONAL.filter((k) => typeof v.sections?.[k] === "boolean").map(
            (k) => [k, v.sections[k]],
          ),
        ),
      };
    } catch {
      return { note: "", sections: {} };
    }
  };
  /** The experiment (`--system-prompt-snapshot off`) is on for this session. */
  const freshFor = (s: Session, st = settings()) =>
    st.claudeFresh &&
    s.agent === "claude" &&
    !s.sidecar &&
    (st.freshList.includes(s.id) || st.freshList.includes(s.ownerId));
  /** Why the layers are not what this session's Runner gets (null = they are). */
  const offWhy = (s: Session): Words | null => {
    const st = settings();
    // P4-10: ACP has no system-prompt channel (any ACP harness).
    if (isAcpAgent(s.agent))
      return (t) => t("prompt-admin.off.acp", { engine: agentShortName(s.agent) });
    const listed =
      st.sessions.includes(s.id) ||
      st.users.includes(s.ownerId) ||
      (!!s.sidecar && st.sessions.includes(s.sidecar.parent));
    if (st.mode === "off" || (st.mode === "allowlist" && !listed))
      return st.mode === "off"
        ? (t) => t("prompt-admin.off.disabled")
        : (t) => t("prompt-admin.off.notListed");
    if (!(caps(s.nodeId)?.promptLayers?.version >= 1))
      return (t) => t("prompt-admin.off.oldRunner");
    // `all` only with a core that knows it may come through Daisy: under
    // the long version every session would still print the banner and
    // sync the local files (a pilot from the list may, knowingly).
    if (st.mode === "all") {
      // …and only with a core the control plane read itself: a Runner's
      // unchecked word is for a named pilot, never for everyone.
      // (Every session, the listed ones too: under `all` the list is not
      // looked at — an admin who wants a pilot meanwhile switches to it.)
      if (!authority())
        return (t) => t("prompt-admin.off.noAuthority");
      const org = orgOf(s.nodeId);
      if (org?.body && !coreKnowsInjection(org.body))
        return (t) => t("prompt-admin.off.oldCore", { mark: INJECT_MARK });
    }
    return null;
  };
  /** The four layers of `s` as they would be composed now. */
  const compose = (s: Session): ComposedGuide => {
    const st = settings();
    return composeGuide({
      session: s,
      org: orgOf(s.nodeId),
      prefs: s.kind === "resident" || s.sidecar ? null : prefsOf(s.ownerId),
      // a sidecar has no Daisy tools (nor any collaboration rules).
      features: s.sidecar ? null : deps.features,
      daisyTools: !s.sidecar,
      // ADR-154: by the names its Runner serves them for this conversation.
      toolNames: toolNamesFor(s, caps(s.nodeId)),
      staticRules: st.staticRules,
      fresh: freshFor(s, st),
      epoch: st.epoch + (s.promptEpoch || 0),
      now: Date.now(),
      hash,
      ...(deps.orgCore ? { orgRawCommand: deps.orgCore.rawCommand } : {}),
      ...(deps.orgCore?.changeVia ? { orgChangeVia: deps.orgCore.changeVia } : {}),
    });
  };
  /** `RunnerJob.guide` of a job of `s`, or nothing (then all is as before). */
  let guideFailedAt = 0;
  const guideFor = (s: Session): JobGuide | undefined => {
    try {
      return offWhy(s) ? undefined : jobGuide(compose(s));
    } catch (e: any) {
      // Never in the way of a job: the older text goes instead — said in
      // the log (at most once a minute), not swallowed.
      if (Date.now() - guideFailedAt > 60_000) {
        guideFailedAt = Date.now();
        log.error(
          `[prompt-layers] could not compose the layered prompt for session ${s.id}; this turn goes with the older text: ${String(e?.stack || e?.message || e).slice(0, 600)}`,
        );
      }
      return undefined;
    }
  };
  /** When does a changed text reach the Agent of `s` (stage 0)? */
  const effect = (s: Session, on: boolean, t: Translate) => {
    const version = caps(s.nodeId)?.agentFeatures?.[s.agent]?.cliVersion;
    const measured = on && promptRefreshAt(s.agent, version);
    if (measured && s.agent === "codex")
      return {
        effect: "next-start" as const,
        effectText: t("prompt-admin.effect.codex"),
      };
    if (measured && freshFor(s))
      return {
        effect: "next-start" as const,
        effectText: t("prompt-admin.effect.fresh"),
      };
    const engine = agentShortName(s.agent);
    return {
      effect: "after-compact" as const,
      effectText: t("prompt-admin.effect.afterCompact", {
        engine,
        apply: t(
          on && s.agent === "claude"
            ? "prompt-admin.effect.afterCompact.applyButton"
            : "prompt-admin.effect.afterCompact.compactCmd",
        ),
        off: on ? "" : t("prompt-admin.effect.afterCompact.offToo"),
      }),
    };
  };
  /** `summary` is rendered by the caller in its request's language (`t`). */
  const logEdit = (
    t: Translate,
    scope: "user" | "session",
    scopeId: string,
    uid: string,
    action: string,
    summary: string,
    before: unknown,
    after: unknown,
  ) =>
    store.run(
      "INSERT INTO prompt_edit_log(id,scope,scope_id,user_id,at,action,summary,before,after) VALUES(?,?,?,?,?,?,?,?,?)",
      id(),
      scope,
      scopeId,
      uid,
      Date.now(),
      action,
      summary || t("prompt-admin.history.noChange"),
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
    );
  const history = (scope: "user" | "session", scopeId: string) =>
    store
      .all(
        "SELECT * FROM prompt_edit_log WHERE scope=? AND scope_id=? ORDER BY at DESC, rowid DESC LIMIT 20",
        scope,
        scopeId,
      )
      .map((r) => ({
        at: r.at as number,
        by: username(r.user_id),
        action: r.action as string,
        summary: r.summary as string,
      }));
  /** A note as stored: trimmed, within the limit, no forged layer marker. */
  /** `what`: which note, in the request's words (`prompt-admin.note.*`). */
  const cleanNote = (v: string, what: string) => {
    const text = v.trim();
    if (text.length > GUIDE_LIMITS.noteMax)
      fail(400, "prompt_note_too_long", "prompt-admin.note.tooLong", {
        what,
        max: GUIDE_LIMITS.noteMax,
        n: text.length,
      });
    const m = forgedMarker(text);
    if (m)
      fail(400, "prompt_forged_marker", "prompt-admin.note.forged", { what, marker: m });
    return text;
  };
  const optionalTitle = (t: Translate, k: PromptOptional) =>
    t.dynamic(PROMPT_OPTIONAL_TITLE_KEY[k]);
  const sectionWords = (
    t: Translate,
    before: Partial<Record<PromptOptional, boolean>>,
    after: Partial<Record<PromptOptional, boolean>>,
    follow: string,
  ) =>
    PROMPT_OPTIONAL.filter((k) => before[k] !== after[k]).map((k) =>
      after[k] === undefined
        ? t("prompt-admin.history.sectionFollow", { title: optionalTitle(t, k), follow })
        : t(after[k] ? "prompt-admin.history.sectionOn" : "prompt-admin.history.sectionOff", {
            title: optionalTitle(t, k),
          }),
    );
  const noteWords = (t: Translate, before: string, after: string, what: string) =>
    before === after
      ? []
      : [
          t(
            after
              ? before
                ? "prompt-admin.history.noteChanged"
                : "prompt-admin.history.noteWritten"
              : "prompt-admin.history.noteCleared",
            { what },
          ),
        ];
  // ── Runner: the org core it read ─────────────────────────────────────
  // P1-03: the owner is the only one to tell.
  const admins = (): string[] => [OWNER_ID];
  /**
   * 「有节点上报的启动核心与期望哈希不符」 — one notification for the
   * whole state, in general words (no node's hash, version or words in
   * it): while some node in use goes on reporting a text that is not the
   * expected one, at most one every `ORG_NOTIFY_GAP_MS`; once every node
   * matches it is armed again (never two within `ORG_NOTIFY_MIN_MS`). So
   * whoever is first — a forger too — cannot use up the one reminder a
   * real L1 revision needs: it comes again while the state lasts.
   * Called after a report and when the switch is turned off.
   */
  const mismatchWatch = () => {
    const st = settings(),
      now = Date.now();
    const read = (): { on: boolean; last: number } => {
      try {
        const v = JSON.parse(
          store.one("SELECT value FROM prompt_layer_settings WHERE key='org-mismatch'")
            ?.value || "{}",
        );
        return { on: !!v.on, last: Number(v.last) || 0 };
      } catch {
        return { on: false, last: 0 };
      }
    };
    const write = (v: { on: boolean; last: number }) =>
      store.run(
        "INSERT INTO prompt_layer_settings(key,value) VALUES('org-mismatch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        JSON.stringify(v),
      );
    // Only where the expected hash decides: the switch on, the control
    // plane without a text of its own, a hash typed in.
    const some =
      st.mode !== "off" &&
      !!st.orgExpected &&
      !ownCopy() &&
      !!store.one(
        `SELECT 1 FROM node_org_guides g JOIN nodes n ON n.id=g.node_id
          WHERE g.sha256<>'' AND g.accepted=0 AND g.reported_at>? AND COALESCE(n.revoked_at,0)=0`,
        now - ORG_NODE_ACTIVE_MS,
      );
    const was = read();
    if (!some) {
      if (was.on) write({ on: false, last: was.last });
      return;
    }
    // Armed but too soon after the last one: stays armed, so the reminder
    // comes as soon as the minimum gap is over — not a whole
    // `ORG_NOTIFY_GAP_MS` after a reminder someone else set off.
    const due =
      now - was.last >= (was.on ? ORG_NOTIFY_GAP_MS : ORG_NOTIFY_MIN_MS);
    if (!due) return;
    write({ on: true, last: now });
    const t = ownerT();
    for (const uid of admins())
      deps.notify?.(
        uid,
        `prompt-org-mismatch:${now}`,
        t("prompt-admin.notify.mismatch.title"),
        t("prompt-admin.notify.mismatch.body", { hint: verifyHint(t) }),
      );
  };
  deps.runner.post("/org-guide", async (req: any, reply: any) => {
    const n = deps.node(req);
    // The switch is off: nothing is taken, stored, logged or told (a
    // Runner is not asked to report then; one that still does is ignored).
    if (settings().mode === "off") return reply.code(204).send();
    // What is stored about this report is shown to admins later, and
    // what it is answered: the owner's language (a Runner's request names
    // none, and its port's error handler sends the words as they are).
    const ot = ownerT();
    const b = OrgReportSchema.parse(req.body);
    if (Buffer.byteLength(b.body, "utf8") > GUIDE_LIMITS.orgBytesMax)
      refuse(413, "org_guide_too_large", ot("prompt-admin.error.orgTooLarge"));
    if (!ORG_DOC_ID || b.docId !== ORG_DOC_ID)
      refuse(400, "org_guide_wrong_doc", ot("prompt-admin.error.orgWrongDoc"));
    const old = nodeRow(n.id);
    const now = Date.now();
    // What the node says of itself: a known code or "other" — never its
    // own words (`b.problem`, an older Runner's free text, is dropped).
    const self = orgReadReason(b.reason) || (b.problem ? "other" : "") || null;
    /**
     * What this report says about the node — never what sessions get.
     * `text`: a core it reported (its hash, version and whether that is
     * the text in use); absent: an empty or invalid report, which leaves
     * those as they were. `keep`: also its body — only where the control
     * plane has no text of its own, so that the text is there the moment
     * an admin types in its hash (a text the control plane refused is
     * never kept).
     */
    const status = (
      level: number,
      problem: string | null,
      text?: { sha: string; accepted: boolean; keep?: boolean },
    ) =>
      store.run(
        `INSERT INTO node_org_guides(node_id,doc_id,version,sha256,body,fetched_at,level,problem,self_reason,reported_at,accepted) VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(node_id) DO UPDATE SET doc_id=excluded.doc_id,fetched_at=excluded.fetched_at,level=excluded.level,
           problem=excluded.problem,self_reason=excluded.self_reason,reported_at=excluded.reported_at${text ? ",version=excluded.version,sha256=excluded.sha256,body=excluded.body,accepted=excluded.accepted" : ""}`,
        n.id,
        b.docId,
        text ? b.version : 0,
        text ? text.sha : "",
        text?.keep ? b.body : "",
        b.fetchedAt,
        level,
        problem,
        self,
        now,
        text ? (text.accepted ? 1 : 0) : 1,
      );
    const before = old?.sha256 || "";
    /** Is this node's text the one in use: never said / it is / it is not. */
    const stateOf = (r: any) =>
      r?.sha256 ? (r.accepted ? "match" : "mismatch") : "none";
    /**
     * A core was reported: logged — always when whether this node's text
     * is the one in use changed with it, else as any report (limited).
     */
    const logText = (sha: string, accepted: boolean, words: string) =>
      logCore(
        "runner",
        n.id,
        b,
        before,
        sha,
        accepted,
        words,
        stateOf(old) !== (accepted ? "match" : "mismatch") ? "state" : "report",
      );
    // Nothing read (level 4): said on the page; nothing else changes.
    if (b.level === 4 || !b.body.trim()) {
      status(4, ot("prompt-admin.node.nothingRead"));
      logCore(
        "runner",
        n.id,
        { version: 0, level: 4 },
        before,
        "",
        true,
        ot("prompt-admin.log.nothingRead"),
      );
      return { ok: true };
    }
    // Never the Runner's word: what the body is.
    const sha = hash(b.body);
    // Not recognisably a core (no 「## 规则」, no red lines section): not
    // adopted, and — like an empty report — nothing else changes.
    if (!looksLikeOrgCore(b.body)) {
      const why = ot("prompt-admin.node.notCore");
      status(4, why);
      logCore("runner", n.id, b, before, sha, false, why);
      refuse(422, "org_guide_invalid", why);
    }
    // The control plane read L1 itself: that is the text. A report that
    // differs is refused (after one fresh look, in case L1 just changed).
    let own = authority();
    if (own && own.sha256 !== sha) {
      const r = ownRow();
      if (deps.readCore && Date.now() - (r?.checked_at || 0) > 30_000) {
        await readOwn();
        own = authority();
      }
    }
    if (own) {
      if (own.sha256 === sha) {
        status(b.level, null, { sha, accepted: true });
        logText(sha, true, ot("prompt-admin.log.matchOwn"));
        return { ok: true, verified: true, adopted: true };
      }
      const why =
        b.version && b.version < own.version
          ? ot("prompt-admin.node.olderVersion", { own: own.version, reported: b.version })
          : ot("prompt-admin.node.changed", { own: own.version });
      status(b.level, why, { sha, accepted: false });
      logText(sha, false, why);
      refuse(409, "org_guide_mismatch", ot("prompt-admin.error.orgRefused", { why }));
    }
    // The control plane cannot read now, but holds a copy it checked
    // earlier: that copy goes on being used. An unchecked report never
    // replaces a text the control plane checked.
    const copy = ownCopy();
    if (copy) {
      const same = copy.sha256 === sha;
      const why = same
        ? null
        : ot("prompt-admin.node.copyDiffers", { version: copy.version });
      status(b.level, why, { sha, accepted: same });
      logText(sha, same, why ?? ot("prompt-admin.log.copySame"));
      return {
        ok: true,
        verified: false,
        adopted: false,
        ...(why ? { note: why } : {}),
      };
    }
    // The control plane never read L1 (degraded). The only anchor is the
    // hash an admin typed into the settings: a text with that hash is the
    // text; any other is not adopted — and displaces nothing.
    const expected = settings().orgExpected;
    if (expected && sha === expected) {
      status(b.level, null, { sha, accepted: true, keep: true });
      trust(b.body, n.id);
      logText(sha, true, ot("prompt-admin.log.expectedMatch"));
      mismatchWatch();
      return { ok: true, verified: false, adopted: true };
    }
    const why = expected
      ? ot("prompt-admin.node.expectedMismatch", { sha: sha.slice(0, 12), expected: expected.slice(0, 12) })
      : ot("prompt-admin.node.noExpected");
    status(b.level, why, { sha, accepted: false, keep: true });
    logText(sha, false, why);
    mismatchWatch();
    return { ok: true, verified: false, adopted: false, note: why };
  });
  // ── a person's defaults ──────────────────────────────────────────────
  const meView = (uid: string, t: Translate): MyPromptView => {
    const p = prefsOf(uid);
    return {
      note: p.note,
      sections: Object.fromEntries(
        PROMPT_OPTIONAL.map((k) => [k, p.sections[k] ?? PROMPT_OPTIONAL_DEFAULT[k]]),
      ) as Record<PromptOptional, boolean>,
      optional: PROMPT_OPTIONAL.map((k) => ({
        key: k,
        title: optionalTitle(t, k),
        default: PROMPT_OPTIONAL_DEFAULT[k],
      })),
      limits: { noteMax: GUIDE_LIMITS.noteMax },
      history: history("user", uid),
    };
  };
  const P = api.prompts;
  serve(app, P.mineShow, async (req: any) => meView(deps.user(req).id, reqT(req)));
  serve(app, P.mineSet, async (req: any) => {
    const u = deps.user(req),
      b = P.mineSet.body.parse(req.body || {}),
      t = reqT(req);
    const old = prefsOf(u.id);
    const what = t("prompt-admin.note.mine");
    const next: UserPromptPrefs = {
      note: b.note === undefined ? old.note : cleanNote(b.note, what),
      sections: { ...old.sections },
    };
    for (const k of PROMPT_OPTIONAL) {
      const v = b.sections?.[k];
      if (v === null) delete next.sections[k];
      else if (typeof v === "boolean") next.sections[k] = v;
    }
    const words = [
      ...noteWords(t, old.note, next.note, what),
      ...sectionWords(t, old.sections, next.sections, t("prompt-admin.history.followDefault")),
    ];
    store.atomic(() => {
      store.run(
        "INSERT INTO user_prompt_prefs(user_id,body,updated) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body,updated=excluded.updated",
        u.id,
        JSON.stringify(next),
        Date.now(),
      );
      logEdit(t, "user", u.id, u.id, "update", words.join(t("prompt-admin.list.separator")), old, next);
    });
    store.audit(u.id, "prompt.user.update", u.id);
    return meView(u.id, t);
  });
  // ── one session ──────────────────────────────────────────────────────
  /** Its owner only: not an admin, not a member of a group it is in. */
  const owned = (req: any, sid: string) => {
    const s = deps.session(req, sid);
    if (s.ownerId !== deps.user(req).id)
      fail(403, "not_own_session", "prompt-admin.error.notOwner");
    return s;
  };
  const lastLaunch = (sid: string) => {
    try {
      const r = store.one(
        "SELECT data FROM items WHERE session_id=? AND id LIKE '%:launch-audit' ORDER BY json_extract(data,'$.createdAt') DESC LIMIT 1",
        sid,
      );
      if (!r) return null;
      const d = JSON.parse(r.data);
      const { layers: _l, ...input } = d.input || {};
      return { at: d.createdAt, chars: String(d.text || "").length, ...input };
    } catch {
      return null;
    }
  };
  /**
   * Is the composed text what this conversation's system layer holds —
   * by what its Runner reported (`session.nativeGuide`)? A text that
   * arrived by rendering afresh counts only while that is still on.
   */
  /** `t`: the language of `effectiveText` (none: only whether it took effect). */
  const effectiveOf = (s: Session, g: ComposedGuide, on: boolean, t?: Translate) => {
    const d =
      s.nativeGuide && s.nativeGuide.thread === s.nativeId
        ? s.nativeGuide
        : null;
    const holds = !!d && (d.via !== "fresh" || freshFor(s));
    const effective: SessionPromptView["effective"] =
      !on || !holds ? "unknown" : d!.sha256 === g.sha256 ? "yes" : "stale";
    return {
      delivered: holds ? d : null,
      effective,
      effectiveText: !t
        ? ""
        : t(
            effective === "yes"
              ? "prompt-admin.effective.yes"
              : effective === "stale"
                ? s.agent === "codex"
                  ? "prompt-admin.effective.staleCodex"
                  : "prompt-admin.effective.stale"
                : on
                  ? s.nativeId
                    ? "prompt-admin.effective.unconfirmed"
                    : "prompt-admin.effective.notStarted"
                  : "prompt-admin.effective.off",
          ),
    };
  };
  const applyRow = (sid: string) =>
    store.one("SELECT * FROM prompt_apply_queue WHERE session_id=?", sid);
  /**
   * Can a compaction bring the current text to `s` now (null = yes)?
   * `done`: it needs none — the text is in effect already.
   */
  const applyWhyNot = (
    s: Session,
    g: ComposedGuide,
    on: boolean,
  ): { key: MessageKey; done?: true } | null => {
    if (!on) return { key: "prompt-admin.apply.off" };
    if (s.agent !== "claude")
      return {
        key: s.agent === "codex" ? "prompt-admin.apply.codex" : "prompt-admin.apply.noChannel",
      };
    if (s.sidecar) return { key: "prompt-admin.apply.sidecar" };
    if (s.archived) return { key: "prompt-admin.apply.archived" };
    if (!s.nativeId) return { key: "prompt-admin.apply.notStarted" };
    if (residentHeld(s)) return { key: "prompt-admin.apply.paused" };
    if (freshFor(s)) return { key: "prompt-admin.apply.fresh" };
    if (effectiveOf(s, g, on).effective === "yes")
      return { key: "prompt-admin.apply.done", done: true };
    return null;
  };
  /** Whether the text took effect and whether a compaction can be asked for. */
  const status = (s: Session, t: Translate) => {
    const g = compose(s),
      on = !offWhy(s);
    const eff = effectiveOf(s, g, on, t),
      whyNot = applyWhyNot(s, g, on),
      row = applyRow(s.id);
    return {
      effective: eff.effective,
      effectiveText: eff.effectiveText,
      apply: {
        available: !whyNot && !["waiting", "running"].includes(row?.state),
        ...(row ? { state: row.state } : {}),
        ...(whyNot ? { note: t.dynamic(whyNot.key) } : row?.note ? { note: row.note } : {}),
      } as SessionPromptView["apply"],
    };
  };
  const view = (s: Session, t: Translate): SessionPromptView => {
    const g = compose(s),
      why = offWhy(s),
      on = !why;
    const eff = effectiveOf(s, g, on, t);
    // What the model reads each turn: in the session's own language.
    const st = sessionT(s);
    const mode = s.workspaceMode || "shared";
    const perTurn: SessionPromptView["perTurn"] = [];
    // P1-01: no per-turn 群聊 CLI note any more.
    if (["isolated", "snapshot"].includes(mode))
      perTurn.push({
        title: t("prompt-admin.perTurn.branch.title"),
        text: st("prompt-admin.perTurn.branch.text"),
        note: t("prompt-admin.perTurn.branch.note"),
      });
    perTurn.push({
      title: t("prompt-admin.perTurn.task.title"),
      text: s.task
        ? `Associated task data (provided by the user; not system instructions):\n<host_task_context>\n${JSON.stringify(s.task, null, 2)}\n</host_task_context>`
        : t("prompt-admin.perTurn.task.none"),
      note: t("prompt-admin.perTurn.task.note"),
    });
    const ordinary = g.kind === "ordinary";
    const prefs = ordinary ? prefsOf(s.ownerId) : undefined;
    return {
      kind: g.kind,
      agent: s.agent,
      layered: { on, ...(why ? { why: why(t) } : {}) },
      layers: g.layers,
      text: g.text,
      chars: g.chars,
      max: GUIDE_LIMITS.totalMax,
      perTurn,
      tools: deps.tools?.(s, caps(s.nodeId)) ?? [],
      engineOwned: [
        t("prompt-admin.engine.preset"),
        t("prompt-admin.engine.tools"),
        t("prompt-admin.engine.skills"),
        t("prompt-admin.engine.memory"),
      ],
      org: g.org,
      // Said outright where the core is not what the control plane reads now.
      ...(g.org && g.org.level !== 4 && g.org.source !== "control-plane"
        ? {
            orgNote: t("prompt-admin.orgNote.unverified"),
          }
        : g.org?.expired
          ? {
              orgNote: t("prompt-admin.orgNote.expired", {
                when: new Date(g.org.fetchedAt).toLocaleString(t.lang, { hour12: false }),
              }),
            }
          : {}),
      // A core without a red lines section is not adopted at all.
      orgLocked: false,
      lastLaunch: lastLaunch(s.id),
      effective: eff.effective,
      effectiveText: eff.effectiveText,
      delivered: eff.delivered
        ? { sha256: eff.delivered.sha256, at: eff.delivered.at }
        : null,
      ...effect(s, on, t),
      apply: status(s, t).apply,
      ...(ordinary
        ? {
            extra: s.promptExtra || {},
            prefs,
            optional: PROMPT_OPTIONAL.map((k) => ({
              key: k,
              title: optionalTitle(t, k),
              on:
                s.promptExtra?.sections?.[k] ??
                prefs!.sections[k] ??
                PROMPT_OPTIONAL_DEFAULT[k],
              own: s.promptExtra?.sections?.[k] ?? null,
            })),
          }
        : {}),
      limits: { noteMax: GUIDE_LIMITS.noteMax, totalMax: GUIDE_LIMITS.totalMax },
      history: history("session", s.id),
    };
  };
  serve(app, api.sessionPrompts.promptShow, async (req: any) =>
    view(owned(req, req.params.id), reqT(req)),
  );
  serve(app, api.sessionPrompts.promptExtra, async (req: any) => {
    const s0 = owned(req, req.params.id),
      uid = deps.user(req).id,
      t = reqT(req);
    if (s0.kind === "resident")
      fail(409, "resident_prompt", "prompt-admin.error.residentPrompt");
    if (s0.sidecar) fail(409, "sidecar_prompt", "prompt-admin.error.sidecarPrompt");
    const what = t("prompt-admin.note.session");
    const b = api.sessionPrompts.promptExtra.body.parse(req.body || {});
    const saved = store.atomic(() => {
      const s = store.session(s0.id)!;
      const old: SessionPromptExtra = s.promptExtra || {};
      const next: SessionPromptExtra = {
        ...(old.note ? { note: old.note } : {}),
        sections: { ...(old.sections || {}) },
      };
      if (b.note !== undefined) {
        const note = b.note === null ? "" : cleanNote(b.note, what);
        if (note) next.note = note;
        else delete next.note;
      }
      for (const k of PROMPT_OPTIONAL) {
        const v = b.sections?.[k];
        if (v === null) delete next.sections![k];
        else if (typeof v === "boolean") next.sections![k] = v;
      }
      if (!Object.keys(next.sections!).length) delete next.sections;
      const before = compose(s).chars;
      if (Object.keys(next).length) s.promptExtra = next;
      else delete s.promptExtra;
      const after = compose(s).chars;
      if (after > GUIDE_LIMITS.totalMax && after > before)
        fail(400, "prompt_too_long", "prompt-admin.error.tooLong", {
          after,
          max: GUIDE_LIMITS.totalMax,
        });
      s.updatedAt = Date.now();
      store.save(s);
      logEdit(
        t,
        "session",
        s.id,
        uid,
        "update",
        [
          ...noteWords(t, old.note || "", next.note || "", what),
          ...sectionWords(t, old.sections || {}, next.sections || {}, t("prompt-admin.history.followMine")),
        ].join(t("prompt-admin.list.separator")),
        old,
        next,
      );
      return s;
    });
    store.audit(uid, "prompt.session.update", s0.id);
    deps.touched(s0.id);
    return view(saved, t);
  });
  // ── 「立即压缩并生效」: one compaction per conversation, one at a time ──
  let compact:
    | ((
        s: Session,
        requestId: string,
        /** Who asked (the audit names her, not the session's owner). */
        actorId: string,
      ) => { id: string } | { error: string })
    | null = null;
  /** `batch`: an admin's 「立即生效」 (null: its owner asked for this one). */
  const enqueue = (
    s: Session,
    by: string,
    priority: number,
    batch: string | null = null,
  ) =>
    store.run(
      `INSERT INTO prompt_apply_queue(session_id,requested_at,requested_by,priority,state,tries,job_id,note,updated,batch) VALUES(?,?,?,?,'waiting',0,NULL,NULL,?,?)
       ON CONFLICT(session_id) DO UPDATE SET requested_at=excluded.requested_at,requested_by=excluded.requested_by,
         priority=excluded.priority,state='waiting',tries=0,job_id=NULL,note=NULL,updated=excluded.updated,batch=excluded.batch
       WHERE prompt_apply_queue.state NOT IN ('waiting','running')`,
      s.id,
      Date.now(),
      by,
      priority,
      Date.now(),
      batch,
    );
  /**
   * The switch goes off: nothing more is compacted for it. Waiting
   * requests are cancelled; a compaction already handed to a node's queue
   * that its Runner has not claimed is withdrawn; one a Runner is running
   * goes on to its end.
   */
  const stopQueue = (t: Translate, why: string) => {
    const now = Date.now();
    const waiting = store.run(
      "UPDATE prompt_apply_queue SET state='cancelled',note=?,updated=? WHERE state='waiting'",
      t("prompt-admin.queue.withdrawnWaiting", { why }),
      now,
    ).changes as number;
    let withdrawn = 0,
      running = 0;
    for (const r of store.all(
      "SELECT session_id,job_id FROM prompt_apply_queue WHERE state='running'",
    )) {
      const words = t("prompt-admin.queue.withdrawnJob", { why });
      if (r.job_id && deps.withdrawQueued?.(r.job_id, words)) {
        setRow(r.session_id, "cancelled", words);
        withdrawn++;
      } else running++;
    }
    store.run("DELETE FROM prompt_apply_tokens");
    return { waiting, withdrawn, running };
  };
  /** Conversations of an admin's batch still waiting or being compacted. */
  const batchOpen = () =>
    store.one(
      "SELECT COUNT(*) n FROM prompt_apply_queue WHERE batch IS NOT NULL AND state IN ('waiting','running')",
    ).n as number;
  const setRow = (
    sid: string,
    state: string,
    words: string | null,
    job?: string,
  ) =>
    store.run(
      "UPDATE prompt_apply_queue SET state=?,note=?,job_id=COALESCE(?,job_id),updated=? WHERE session_id=?",
      state,
      words,
      job ?? null,
      Date.now(),
      sid,
    );
  const lastStart = new Map<string, number>();
  /** One pass over the queue (a timer; tests call it). */
  const applyTick = (now = Date.now()) => {
    if (deps.leading && !deps.leading()) return;
    // Notes stored for the page: the owner's language (no request here).
    const t = ownerT();
    const busy = new Set<string>();
    for (const r of store.all(
      "SELECT * FROM prompt_apply_queue WHERE state='running'",
    )) {
      const s = store.session(r.session_id);
      const j = r.job_id
        ? store.one("SELECT status FROM jobs WHERE id=?", r.job_id)
        : null;
      if (s && j && ["queued", "running", "pending"].includes(j.status)) {
        if (now - r.updated > 30 * 60_000)
          setRow(r.session_id, "failed", t("prompt-admin.queue.timeout"));
        else busy.add(s.nodeId);
        continue;
      }
      const ok =
        !!s && effectiveOf(s, compose(s), !offWhy(s)).effective === "yes";
      setRow(
        r.session_id,
        ok ? "done" : "failed",
        ok ? null : t("prompt-admin.queue.notConfirmed"),
      );
    }
    const gap = deps.applyGapMs ?? APPLY_GAP_MS;
    for (const r of store.all(
      "SELECT * FROM prompt_apply_queue WHERE state='waiting' ORDER BY priority DESC, requested_at, rowid",
    )) {
      const s = store.session(r.session_id);
      if (!s || s.deleting) {
        store.run(
          "DELETE FROM prompt_apply_queue WHERE session_id=?",
          r.session_id,
        );
        continue;
      }
      const why = applyWhyNot(s, compose(s), !offWhy(s));
      if (why) {
        setRow(s.id, why.done ? "done" : "skipped", why.done ? null : t.dynamic(why.key));
        continue;
      }
      if (now - r.requested_at > APPLY_WAIT_MS) {
        setRow(s.id, "skipped", t("prompt-admin.queue.idleTimeout"));
        continue;
      }
      if (busy.has(s.nodeId) || now - (lastStart.get(s.nodeId) || 0) < gap)
        continue;
      const node = store.one("SELECT last_seen FROM nodes WHERE id=?", s.nodeId);
      // Its device is offline: waits.
      if (!node || now - node.last_seen > 60_000) continue;
      if (!compact) continue;
      const out = compact(s, `prompt-apply-${r.requested_at}`, r.requested_by);
      if ("error" in out) {
        // Busy now (a turn, a login): looked at again on a later pass.
        store.run(
          "UPDATE prompt_apply_queue SET tries=tries+1,note=?,updated=? WHERE session_id=?",
          out.error,
          now,
          s.id,
        );
        continue;
      }
      setRow(s.id, "running", null, out.id);
      busy.add(s.nodeId);
      lastStart.set(s.nodeId, now);
    }
  };
  const applyTimer = setInterval(() => {
    try {
      applyTick();
    } catch (e: any) {
      log.error("prompt apply queue:", e?.message);
    }
  }, 5000);
  (applyTimer as any).unref?.();
  const coreTimer = deps.readCore
    ? setInterval(() => void readOwn(), deps.coreMs ?? ORG_CORE_MS)
    : null;
  (coreTimer as any)?.unref?.();
  // The first read does not hold up start-up.
  if (deps.readCore) void readOwn();
  app.addHook?.("onClose", async () => {
    stopped = true;
    clearInterval(applyTimer);
    if (coreTimer) clearInterval(coreTimer);
  });
  /** Its owner: compact this conversation now, so it takes the current text. */
  serve(app, api.sessionPrompts.promptApply, async (req: any) => {
    const s0 = owned(req, req.params.id),
      uid = deps.user(req).id,
      t = reqT(req);
    const why = applyWhyNot(s0, compose(s0), !offWhy(s0));
    if (why)
      fail(409, "prompt_apply_refused", "prompt-admin.error.applyRefused", {
        why: t.dynamic(why.key),
      });
    // Settle what already ended, so an earlier request does not stand in the way.
    applyTick();
    const s = store.atomic(() => {
      const cur = store.session(s0.id)!;
      // A new process key: the compaction runs in a process launched with
      // the newest text (an L1 update alone does not restart one).
      cur.promptEpoch = (cur.promptEpoch || 0) + 1;
      store.save(cur);
      enqueue(cur, uid, 1);
      return cur;
    });
    store.audit(uid, "prompt.session.apply", s.id);
    applyTick();
    return view(store.session(s.id)!, t);
  });
  // ── admins: the switch, 「立即生效」, what each node reported ───────────
  // P1-03: the owner (the guard checks the route's scope).
  const adminOnly = (req: any) => deps.user(req);
  /** The core `mode: "all"` is judged by, and what is known about it. */
  const reference = (t: Translate): PromptLayerAdminView["core"] => {
    const own = ownRow(),
      copy = ownCopy();
    const off = settings().mode === "off";
    // `own.problem` was written in words when the read failed (stored as it is).
    const problem = deps.readCore
      ? authority()
        ? ""
        : off && !own
          ? t("prompt-admin.core.offNoRead")
          : own?.problem || t("prompt-admin.core.notRead")
      : t(deps.orgCore ? "prompt-admin.core.noReadPath" : "prompt-admin.core.noPlugin");
    if (copy)
      return {
        source: "control-plane",
        version: copy.version,
        sha256: copy.sha256,
        fetchedAt: copy.fetchedAt,
        problem,
        knowsInjection: coreKnowsInjection(copy.body),
        // Its last good read is more than a day old: still used, not an
        // authority any more.
        ...(copy.expired ? { expired: true } : {}),
      };
    // The control plane never read L1: the text whose hash is the
    // admin's expected hash, once some node reported it. Else nothing.
    const expected = settings().orgExpected,
      tr = trustedRow();
    if (!expected || !tr?.body || tr.sha256 !== expected)
      return {
        source: "none",
        version: 0,
        sha256: "",
        fetchedAt: 0,
        problem,
        knowsInjection: false,
      };
    return {
      source: "runner",
      // No version: only a node could have said one.
      version: 0,
      sha256: tr.sha256,
      fetchedAt: tr.at,
      problem,
      knowsInjection: coreKnowsInjection(tr.body),
    };
  };
  /** The people a pilot list covers: those named, and the owners of the sessions named. */
  const pilotPeople = (st: Pick<PromptLayerSettings, "sessions" | "users">) =>
    new Set([
      ...st.users,
      ...st.sessions
        .map((x) => store.session(x)?.ownerId)
        .filter((x): x is string => !!x),
    ]).size;
  const pilotMax = deps.pilotMax ?? PILOT_MAX;
  /** A hash a node reported, as admins get it: its first 12 digits. */
  const reported = (sha: unknown) => String(sha || "").slice(0, 12);
  const adminView = (
    t: Translate,
    extra: Pick<
      PromptLayerAdminView,
      "pruned" | "warnings" | "estimate" | "cancelled" | "stillRunning" | "noop"
    > = {},
  ): PromptLayerAdminView => {
    const st = settings(),
      core = reference(t),
      now = Date.now();
    const nodes = store
      .all(
        `SELECT n.id,n.label,n.capabilities,n.last_seen,g.doc_id,g.version,g.sha256,g.level,g.problem,g.self_reason,g.reported_at,g.accepted,g.log_dropped
           FROM nodes n LEFT JOIN node_org_guides g ON g.node_id=n.id
          WHERE COALESCE(n.revoked_at,0)=0 ORDER BY n.label`,
      )
      .map((r) => {
        let c: any = {};
        try {
          c = JSON.parse(r.capabilities || "{}");
        } catch {}
        const reason = orgReadReason(r.self_reason);
        return {
          id: r.id as string,
          ...namedFor("node", r.label, t),
          lastSeen: r.last_seen as number,
          active: now - (r.last_seen as number) < ORG_NODE_ACTIVE_MS,
          promptLayers: c?.promptLayers?.version >= 1,
          // A node's own words too (its heartbeat is not checked for
          // shape): a string of release characters, cut — never an array,
          // an object or a sentence with a hash to copy in it.
          release:
            typeof c?.runner?.release === "string" && /^[\w.+-]{1,100}$/.test(c.runner.release)
              ? c.runner.release.slice(0, 12)
              : null,
          org: r.doc_id
            ? {
                docId: r.doc_id as string,
                // Cut: nothing a node reports is something to copy into
                // the expected hash.
                sha256: reported(r.sha256),
                reportedAt: r.reported_at as number,
                accepted: !!r.accepted,
                ...(r.problem ? { problem: r.problem as string } : {}),
                // What the node said of itself: its claims, not ours —
                // numbers and a code with fixed words, never free text.
                self: {
                  version: r.version as number,
                  level: r.level as number,
                  ...(reason
                    ? { reason, reasonText: t.dynamic(ORG_READ_REASON_KEY[reason]) }
                    : {}),
                },
                ...(r.log_dropped ? { logDropped: r.log_dropped as number } : {}),
              }
            : null,
        };
      });
    const full = new Map<string, string>(
      store
        .all("SELECT node_id,sha256 FROM node_org_guides")
        .map((r) => [r.node_id as string, r.sha256 as string]),
    );
    // Compared and alerted: the nodes in use only (not revoked — the
    // query above — and heard from in the last day).
    const live = nodes.filter((n) => n.active && n.org);
    const degraded = core.source !== "control-plane";
    // What is in use: the control plane's text, else the expected hash.
    const inUse = degraded ? st.orgExpected : core.sha256;
    const read = live.filter((n) => n.org!.sha256);
    const inconsistent = read
      .filter((n) => !!inUse && full.get(n.id) !== inUse)
      .map((n) => n.id);
    const alerts: string[] = [];
    const alertsOn = () => {
      if (degraded)
        alerts.push(
          st.orgExpected
            ? t("prompt-admin.alert.degradedExpected", {
                problem: core.problem,
                hint: verifyHint(t),
                none: core.source === "none" ? t("prompt-admin.alert.degradedNone") : "",
              })
            : t("prompt-admin.alert.degradedNoExpected", { problem: core.problem, hint: verifyHint(t) }),
        );
      else if (core.expired)
        alerts.push(
          t("prompt-admin.alert.expired", {
            problem: core.problem,
            version: core.version,
            when: new Date(core.fetchedAt).toLocaleString(t.lang, { hour12: false }),
          }),
        );
      else if (st.orgExpected && st.orgExpected !== core.sha256)
        alerts.push(t("prompt-admin.alert.expectedDiffers"));
      for (const n of live.filter((x) => x.org!.sha256 && !x.org!.accepted))
        alerts.push(
          degraded && st.orgExpected
            ? t("prompt-admin.alert.nodeMismatchExpected", { label: n.label })
            : t("prompt-admin.alert.nodeRefused", {
                label: n.label,
                problem: n.org!.problem || t("prompt-admin.alert.nodeRefusedDefault"),
              }),
        );
      const liveIds = new Set(live.map((n) => n.id));
      for (const r of store.all(
        "SELECT node_id,COUNT(*) n FROM org_guide_log WHERE source='runner' AND at>? GROUP BY node_id HAVING COUNT(*)>=3",
        now - 24 * 3600_000,
      ))
        if (liveIds.has(r.node_id))
          alerts.push(
            t("prompt-admin.alert.nodeChurn", { label: nodeLabel(r.node_id, t), n: r.n }),
          );
      if (st.mode === "all" && !authority())
        alerts.push(t("prompt-admin.alert.allStopped"));
      if (st.mode !== "off" && core.source !== "none" && !core.knowsInjection)
        alerts.push(t("prompt-admin.alert.oldCore", { mark: INJECT_MARK }));
      if (st.mode === "allowlist" && !authority() && pilotPeople(st) > pilotMax)
        alerts.push(t("prompt-admin.alert.pilotTooMany", { people: pilotPeople(st), max: pilotMax }));
    };
    // While off nothing is read, reported or injected: nothing to warn of.
    if (st.mode !== "off") alertsOn();
    const count = (state: string) =>
      store.one(
        "SELECT COUNT(*) n FROM prompt_apply_queue WHERE state=? AND updated>?",
        state,
        now - 7 * 86_400_000,
      ).n as number;
    return {
      settings: st,
      docId: ORG_DOC_ID,
      core,
      nodes,
      inconsistent,
      alerts,
      log: store
        .all("SELECT * FROM org_guide_log ORDER BY at DESC, rowid DESC LIMIT 20")
        .map((r) => {
          // A node's line: its hashes cut, its claimed version left out.
          const node = !!r.node_id;
          return {
            at: r.at as number,
            source: r.source as string,
            nodeId: (r.node_id as string) || null,
            version: node ? 0 : (r.version as number),
            before: node ? reported(r.before_sha) : (r.before_sha as string),
            after: node ? reported(r.after_sha) : (r.after_sha as string),
            accepted: !!r.accepted,
            note: r.note as string,
          };
        }),
      apply: {
        waiting: count("waiting"),
        running: count("running"),
        done: count("done"),
        skipped: count("skipped") + count("failed"),
        batch: batchOpen(),
        batchWaiting: store.one(
          "SELECT COUNT(*) n FROM prompt_apply_queue WHERE batch IS NOT NULL AND state='waiting'",
        ).n as number,
      },
      pilotMax,
      verifyHint: verifyHint(t),
      expected: st.orgExpected
        ? {
            sha256: st.orgExpected,
            by: st.orgExpectedBy ? username(st.orgExpectedBy) : "",
            at: st.orgExpectedAt || 0,
            // Has any node reported the text with this hash yet?
            seen: trustedRow()?.sha256 === st.orgExpected,
          }
        : null,
      ...extra,
    };
  };
  serve(app, api.prompts.layersShow, async (req: any) => {
    adminOnly(req);
    // A look moves the queue too (it otherwise moves every few seconds).
    applyTick();
    return adminView(reqT(req));
  });
  serve(app, api.prompts.layersSet, async (req: any) => {
    const u = adminOnly(req),
      b = api.prompts.layersSet.body.parse(req.body || {}),
      t = reqT(req);
    // Being switched on (or already on without a fresh read): the control
    // plane looks at L1 now — while off it does not read the org document at all.
    {
      const seen = settings();
      if (
        (b.mode ?? seen.mode) !== "off" &&
        (seen.mode === "off" || !authority())
      )
        await readOwn(true);
    }
    // From here on one step, in one transaction: the settings are read
    // *after* the wait above and merged with this request's fields only —
    // another admin's save that landed meanwhile (her expected hash) is
    // kept, not written back to what it was when this request arrived.
    const { old, next, pruned, warnings } = store.atomic(() => {
      const old = settings();
      const isSession = (x: string) => !!store.session(x);
      const isUser = (x: string) => x === OWNER_ID;
      const off = (b.mode ?? old.mode) === "off";
      const pruned = {
        sessions: [] as string[],
        users: [] as string[],
        freshList: [] as string[],
      };
      /**
       * A list as saved: what was there and is gone (a deleted session or
       * person) is dropped and said; what is new must exist — except when
       * switching off, which never fails.
       */
      const list = (
        key: "sessions" | "users" | "freshList",
        okId: (x: string) => boolean,
        what: string,
      ) => {
        const was = new Set(old[key]);
        const out: string[] = [];
        for (const x of [...new Set(b[key] ?? old[key])]) {
          if (okId(x)) out.push(x);
          else if (was.has(x) || off) pruned[key].push(x);
          else fail(400, "prompt_list_unknown", "prompt-admin.error.listUnknown", { what, id: x });
        }
        return out;
      };
      const expectedChanged =
        b.orgExpected !== undefined && b.orgExpected !== old.orgExpected;
      const next: PromptLayerSettings = {
        ...old,
        ...b,
        // Who typed the expected hash in, and when.
        ...(expectedChanged
          ? { orgExpectedBy: u.id, orgExpectedAt: Date.now() }
          : {}),
        sessions: list("sessions", isSession, t("prompt-admin.list.sessions")),
        users: list("users", isUser, t("prompt-admin.list.users")),
        freshList: list(
          "freshList",
          (x) => isSession(x) || isUser(x),
          t("prompt-admin.list.either"),
        ),
      };
      const warnings: string[] = [];
      const core = reference(t);
      if (next.mode === "all" && old.mode !== "all") {
        // The hard precondition: a core that knows it may come through
        // Daisy. Under the long version nobody may switch it on for all.
        if (core.source !== "control-plane" || core.expired)
          fail(409, "org_core_unverified", "prompt-admin.error.allUnverified", {
            problem: core.problem,
          });
        if (!core.knowsInjection)
          fail(409, "org_core_not_ready", "prompt-admin.error.allOldCore", { mark: INJECT_MARK });
      }
      if (
        next.mode === "allowlist" &&
        core.source !== "none" &&
        !core.knowsInjection
      )
        warnings.push(t("prompt-admin.warn.pilotOldCore", { mark: INJECT_MARK }));
      // The control plane never read L1: the only anchor is the hash an
      // admin computed herself and typed in. Without it no pilot.
      const anchored = !!ownCopy();
      if (next.mode === "allowlist" && !anchored && !next.orgExpected)
        fail(409, "org_expected_hash_required", "prompt-admin.error.expectedRequired", {
          problem: core.problem,
          doc: ORG_DOC_ID,
          hint: verifyHint(t),
        });
      if (next.mode === "allowlist" && !anchored)
        warnings.push(t("prompt-admin.warn.pilotUnverified", { max: pilotMax }));
      else if (next.mode === "allowlist" && core.expired)
        warnings.push(t("prompt-admin.warn.pilotExpired", { version: core.version, max: pilotMax }));
      // Without the control plane's own read a list is a pilot — not a way
      // to switch it on for everyone by naming everyone. (Checked when the
      // list grows or the mode changes; a save that shrinks it always goes.)
      if (next.mode === "allowlist" && !authority()) {
        const people = pilotPeople(next);
        if (
          people > pilotMax &&
          (old.mode !== "allowlist" || people > pilotPeople(old))
        )
          fail(409, "prompt_pilot_too_many", "prompt-admin.error.pilotTooMany", {
            max: pilotMax,
            people,
          });
      }
      // A hash no node has reported a text for: said at once (a typo would
      // otherwise silently leave the pilot without its org layer).
      if (
        expectedChanged &&
        next.orgExpected &&
        !anchored &&
        trustedRow()?.sha256 !== next.orgExpected &&
        !store.one(
          `SELECT 1 FROM node_org_guides g JOIN nodes n ON n.id=g.node_id
            WHERE g.sha256=? AND COALESCE(n.revoked_at,0)=0`,
          next.orgExpected,
        )
      )
        warnings.push(t("prompt-admin.warn.expectedUnseen"));
      if (next.claudeFresh && !old.claudeFresh)
        warnings.push(t("prompt-admin.warn.fresh"));
      store.atomic(() => {
        saveSettings(next);
        store.audit(
          u.id,
          "prompt.layers.settings",
          JSON.stringify({
            mode: next.mode,
            sessions: next.sessions.length,
            users: next.users.length,
            staticRules: next.staticRules,
            claudeFresh: next.claudeFresh,
            freshList: next.freshList.length,
            orgRead: next.orgRead,
          }).slice(0, 400),
        );
        if (expectedChanged) {
          // Its own audit line: who set which hash.
          store.audit(
            u.id,
            "prompt.org.expected",
            `${old.orgExpected || "-"}->${next.orgExpected || "-"}`,
          );
          logCore(
            "control-plane",
            null,
            { version: 0, level: 1 },
            old.orgExpected,
            next.orgExpected,
            true,
            next.orgExpected
              ? t("prompt-admin.log.expectedSet", { admin: username(u.id), sha: next.orgExpected })
              : t("prompt-admin.log.expectedCleared", { admin: username(u.id) }),
            "act",
          );
          // From now on a node's text is the one in use when it has this
          // hash — also one a node reported before the hash was typed in
          // (L1 was updated, the Runners read it first): adopted at once.
          if (!anchored) {
            for (const r of store.all(
              `SELECT g.* FROM node_org_guides g JOIN nodes n ON n.id=g.node_id
                WHERE g.sha256<>'' AND COALESCE(n.revoked_at,0)=0`,
            )) {
              const match =
                !!next.orgExpected &&
                r.sha256 === next.orgExpected &&
                hash(r.body || "") === next.orgExpected &&
                looksLikeOrgCore(r.body || "");
              if (match) trust(r.body, r.node_id);
              if (!!r.accepted !== match) {
                store.run(
                  "UPDATE node_org_guides SET accepted=?,problem=? WHERE node_id=?",
                  match ? 1 : 0,
                  match ? null : t("prompt-admin.node.expectedMismatchShort"),
                  r.node_id,
                );
                logCore(
                  "runner",
                  r.node_id,
                  { version: r.version, level: r.level },
                  r.sha256,
                  r.sha256,
                  match,
                  t(match ? "prompt-admin.log.expectedNowMatch" : "prompt-admin.log.expectedNoLonger"),
                  "state",
                );
              }
            }
          }
        }
      });
      return { old, next, pruned, warnings };
    });
    // Switched off: what 「立即生效」 still had in line is taken back —
    // waiting ones, and compactions handed to a node's queue that its
    // Runner has not claimed yet. One already under way finishes.
    if (next.mode === "off" && old.mode !== "off") {
      // (Nothing is compared while off: the reminder is armed anew.)
      mismatchWatch();
      const out = stopQueue(t, t("prompt-admin.queue.layersOff"));
      if (out.waiting + out.withdrawn + out.running)
        store.audit(
          u.id,
          "prompt.layers.off-queue",
          `${out.waiting} waiting cancelled; ${out.withdrawn} unclaimed compactions withdrawn; ${out.running} already running go on`,
        );
    }
    const any =
      pruned.sessions.length + pruned.users.length + pruned.freshList.length;
    return adminView(t, {
      ...(any ? { pruned } : {}),
      ...(warnings.length ? { warnings } : {}),
    });
  });
  /** The Claude conversations an admin's 「立即生效」 would compact, newest use first. */
  const applyTargets = () => {
    const now = Date.now();
    const out: Session[] = [];
    for (const r of store.all(
      "SELECT id FROM sessions WHERE json_extract(data,'$.agent')='claude' AND json_extract(data,'$.nativeId') IS NOT NULL",
    )) {
      const s = store.session(r.id);
      if (!s || s.deleting || now - (s.updatedAt || 0) > APPLY_RECENT_MS) continue;
      if (["waiting", "running"].includes(applyRow(s.id)?.state)) continue;
      if (applyWhyNot(s, compose(s), !offWhy(s))) continue;
      out.push(s);
    }
    return out.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
  };
  const setSha = (list: Session[]) =>
    hash(
      list
        .map((x) => x.id)
        .sort()
        .join("\n"),
    );
  const estimate = (limit: number) => {
    const all = applyTargets(),
      take = all.slice(0, limit);
    const owners = (list: Session[]) => new Set(list.map((x) => x.ownerId)).size;
    return {
      take,
      view: {
        sessions: take.length,
        owners: owners(take),
        limit,
        total: all.length,
        truncated: all.length - take.length,
        // One per node starts at once and cannot be taken back.
        immediate: new Set(take.map((x) => x.nodeId)).size,
        people: [...new Set(take.map((x) => x.ownerId))].map((uid) => ({
          username: username(uid),
          sessions: take.filter((x) => x.ownerId === uid).length,
        })),
      } satisfies NonNullable<PromptLayerAdminView["estimate"]>,
    };
  };
  /**
   * 「立即生效」 (admins; red-line changes), in two steps.
   *
   * Without `confirm`: only what it would do — how many conversations of
   * how many people would be compacted (each costs one summary of its
   * whole context); nothing changes. The answer carries a `token`: this
   * admin's, for exactly that set of conversations, good once and for
   * `APPLY_TOKEN_MS`.
   *
   * With `confirm: true` and that token: every process restarts at its
   * next turn with the newest text (the epoch, part of the process key,
   * goes up by one — once per batch), and the conversations of the
   * estimate — at most `limit` (default 20), the most recently used that
   * do not hold the text yet — are compacted, one at a time per node,
   * `APPLY_GAP_MS` apart. The first one of each node starts at once and
   * cannot be cancelled. Audited under the admin who asked.
   *
   * Refused (409) while an earlier batch still has conversations waiting
   * or running, when the token is unknown, used, expired or someone
   * else's, and when the set of conversations is no longer the estimate's.
   */
  serve(app, api.prompts.layersApplyNow, async (req: any) => {
    const u = adminOnly(req),
      t = reqT(req);
    const b = api.prompts.layersApplyNow.body.parse(req.body || {});
    if (settings().mode === "off")
      fail(409, "prompt_layers_off", "prompt-admin.error.layersOff");
    // Settle what already ended, so an earlier request does not stand in the way.
    applyTick();
    const open = batchOpen();
    if (open)
      fail(409, "prompt_apply_busy", "prompt-admin.error.applyBusy", { n: open });
    const now = Date.now();
    if (!b.confirm) {
      const est = estimate(b.limit);
      const token = `${id()}${id()}`.replace(/-/g, "");
      store.run("DELETE FROM prompt_apply_tokens WHERE expires_at<?", now);
      store.run(
        "INSERT INTO prompt_apply_tokens(token_sha,admin_id,set_sha,lim,expires_at,used_at) VALUES(?,?,?,?,?,NULL)",
        hash(token),
        u.id,
        setSha(est.take),
        b.limit,
        now + APPLY_TOKEN_MS,
      );
      return adminView(t, {
        estimate: { ...est.view, token, expiresAt: now + APPLY_TOKEN_MS },
      });
    }
    if (!b.token)
      fail(409, "prompt_apply_token", "prompt-admin.error.tokenMissing");
    const done = store.atomic(() => {
      const tok = store.one(
        "SELECT * FROM prompt_apply_tokens WHERE token_sha=?",
        hash(b.token!),
      );
      const bad: MessageKey | "" = !tok
        ? "prompt-admin.token.unknown"
        : tok.admin_id !== u.id
          ? "prompt-admin.token.otherAdmin"
          : tok.used_at
            ? "prompt-admin.token.used"
            : tok.expires_at < now
              ? "prompt-admin.token.expired"
              : "";
      if (bad) return { error: bad, code: "prompt_apply_token" };
      // Good once: used up from here on, whatever comes next (two
      // confirmations at the same moment — only one gets past this line).
      if (
        store.run(
          "UPDATE prompt_apply_tokens SET used_at=? WHERE token_sha=? AND used_at IS NULL",
          now,
          tok.token_sha,
        ).changes !== 1
      )
        return { error: "prompt-admin.token.used" as MessageKey, code: "prompt_apply_token" };
      const est = estimate(tok.lim as number);
      if (setSha(est.take) !== tok.set_sha)
        return {
          error: "prompt-admin.token.changed" as MessageKey,
          code: "prompt_apply_changed",
        };
      // One confirmation ends every other estimate still open (anyone's).
      store.run(
        "UPDATE prompt_apply_tokens SET used_at=? WHERE used_at IS NULL",
        now,
      );
      const st = settings();
      // Nothing to compact: nothing is done — no epoch, no restart.
      if (!est.take.length) return { est: est.view, epoch: st.epoch, noop: true };
      const batch = `epoch-${st.epoch + 1}`;
      saveSettings({ ...st, epoch: st.epoch + 1 });
      for (const s of est.take) enqueue(s, u.id, 0, batch);
      return { est: est.view, epoch: st.epoch + 1, noop: false };
    });
    if ("error" in done && done.error)
      fail(409, done.code!, "prompt-admin.error.applyRetry", { error: t.dynamic(done.error) });
    const { est, epoch, noop } = done as {
      est: ReturnType<typeof estimate>["view"];
      epoch: number;
      noop: boolean;
    };
    if (noop) return adminView(t, { estimate: est, noop: true });
    store.audit(
      u.id,
      "prompt.layers.apply-now",
      `epoch ${epoch}: ${est.sessions} sessions of ${est.owners} owners${est.truncated ? `, ${est.truncated} over the limit left out` : ""}`,
    );
    applyTick();
    return adminView(t, { estimate: est });
  });
  /**
   * Admins: drop what an admin's 「立即生效」 queued and has not started.
   * A compaction already running finishes (said in the answer); what an
   * owner asked for herself for her own conversation is not touched.
   */
  serve(app, api.prompts.layersApplyCancel, async (req: any) => {
    const u = adminOnly(req),
      t = reqT(req);
    const out = store.atomic(() => {
      const n = store.one(
        "SELECT COUNT(*) n FROM prompt_apply_queue WHERE state='waiting' AND batch IS NOT NULL",
      ).n as number;
      store.run(
        "UPDATE prompt_apply_queue SET state='cancelled',note=?,updated=? WHERE state='waiting' AND batch IS NOT NULL",
        t("prompt-admin.queue.adminCancelled", { admin: username(u.id) }),
        Date.now(),
      );
      const running = store.one(
        "SELECT COUNT(*) n FROM prompt_apply_queue WHERE state='running' AND batch IS NOT NULL",
      ).n as number;
      return { n, running };
    });
    store.audit(
      u.id,
      "prompt.layers.apply-cancel",
      `${out.n} waiting cancelled; ${out.running} already running go on`,
    );
    return adminView(t, { cancelled: out.n, stillRunning: out.running });
  });
  /** Its owner: take back a request that has not started. */
  serve(app, api.sessionPrompts.promptApplyCancel, async (req: any) => {
    const s = owned(req, req.params.id),
      t = reqT(req);
    const r = store.run(
      "UPDATE prompt_apply_queue SET state='cancelled',note=?,updated=? WHERE session_id=? AND state='waiting'",
      t("prompt-admin.queue.ownerCancelled"),
      Date.now(),
      s.id,
    );
    if (r.changes)
      store.audit(deps.user(req).id, "prompt.session.apply-cancel", s.id);
    return view(store.session(s.id)!, t);
  });
  /**
   * A node is revoked (or an admin clears it): what it reported is
   * forgotten. (Never the text in use: that is not a node's.)
   */
  /** `by`: who, in words of the language the log line is written in (`t`). */
  const forgetNode = (nodeId: string, by: string, t: Translate = ownerT()) => {
    const r = nodeRow(nodeId);
    if (!r) return false;
    store.run("DELETE FROM node_org_guides WHERE node_id=?", nodeId);
    if (r.sha256)
      logCore(
        "runner",
        nodeId,
        { version: r.version, level: 4 },
        r.sha256,
        "",
        true,
        t("prompt-admin.log.forgotten", { by }),
        "act",
      );
    return true;
  };
  /** Admins: clear what one node reported (a stale record). */
  serve(app, api.prompts.layersForgetNode, async (req: any) => {
    const u = adminOnly(req),
      t = reqT(req);
    if (!forgetNode(req.params.id, t("prompt-admin.log.byAdmin", { admin: username(u.id) }), t))
      fail(404, "org_guide_none", "prompt-admin.error.nodeNone");
    store.audit(u.id, "prompt.org.forget", req.params.id);
    return adminView(t);
  });
  return {
    settings,
    compose,
    guideFor,
    offWhy,
    effect,
    effectiveOf,
    status,
    orgOf,
    forgetNode,
    /** Read L1 now as the control plane (start-up and a timer do it too). */
    readCore: readOwn,
    applyTick,
    /** How a compaction is queued (the command routes, created later). */
    setCompact: (f: typeof compact) => {
      compact = f;
    },
    /**
     * The state sync's (was the heartbeat's) `orgGuide`: which document Runners read and report —
     * only while the switch is on. Off: absent, as from a control plane
     * without the layered prompt (a Runner then neither reads nor reports).
     */
    heartbeat: (): { orgGuide?: { docId: string; enabled: boolean } } => {
      const st = settings();
      return st.mode !== "off" && st.orgRead && ORG_DOC_ID
        ? { orgGuide: { docId: ORG_DOC_ID, enabled: true } }
        : {};
    },
    /** Is the switch on at all (for anyone)? */
    enabled: () => settings().mode !== "off",
  };
}
export type PromptLayers = ReturnType<typeof promptLayerRoutes>;
