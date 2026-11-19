/**
 * P1-04 (ADR-108): the database structure — the only place it is written.
 *
 * D-06: the old Agent Harbor's data is not imported, so the history of its
 * migrations is not carried: step 1 is the whole structure as it stood
 * when Daisy started from a clean slate. Every later change of structure is
 * one more numbered step appended to MIGRATIONS (store/open.ts runs them,
 * backs the file up first, and rolls back when a step fails).
 *
 * Rules (tests/schema-compat.test.ts checks them):
 * - Step 1 is frozen once merged: never edit it, append a step.
 * - Only add (ADR-104): tables, columns with a default (or
 *   nullable), indexes, triggers. Never drop or rename a table, column or
 *   view: the previous release keeps running on this database after a
 *   rollback. A step that must (only in a major version) sets `breaking`
 *   with the reason; old code then refuses the database instead of
 *   misreading it (store/open.ts) and points at the backup.
 * - No DDL anywhere else in the control plane: modules use the tables
 *   created here. (Plugins keep their own tables, additive only.)
 */

export interface Migration {
  /** 1, 2, 3, … with no gaps. */
  version: number;
  /** What the step changes, one line (kept in `schema_migrations`). */
  note: string;
  /** The change itself; runs inside the upgrade's one transaction. */
  sql: string;
  /**
   * Only for a step old code cannot run on (a drop, a rename, a changed
   * meaning): why it cannot be avoided. Code older than this step refuses
   * the database once it ran (store/open.ts).
   */
  breaking?: string;
}

/**
 * Version 1: the complete structure (2026-11-17, D-06). Grouped as in plan
 * 5.13; the module that uses a table is named above it.
 */
const V1 = `
-- 结构版本记录（store/open.ts）：每一步一行；readable_from = 能在这个库上跑的最旧代码的结构版本。
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL,readable_from INTEGER NOT NULL,note TEXT NOT NULL);

-- 身份档、工作区、设置
CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT NOT NULL,token_hash TEXT NOT NULL,last_seen INTEGER DEFAULT 0,capabilities TEXT DEFAULT '{}', owner_id TEXT, revoked_at INTEGER DEFAULT 0, runner_user TEXT, runner_uid INTEGER, kind TEXT NOT NULL DEFAULT 'local');
CREATE INDEX nodes_owner ON nodes(owner_id);
CREATE INDEX nodes_token ON nodes(token_hash);
CREATE TABLE workspaces(id TEXT PRIMARY KEY,node_id TEXT NOT NULL,label TEXT NOT NULL,path TEXT NOT NULL);
CREATE TABLE profiles(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,node_id TEXT NOT NULL,data TEXT NOT NULL,secret TEXT NOT NULL);
CREATE TABLE retired_identities(profile_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,retired_at INTEGER NOT NULL);
-- commands.ts（ADR-066：每个身份档的原生模型目录）
CREATE TABLE profile_catalogs(profile_id TEXT PRIMARY KEY,data TEXT NOT NULL,at INTEGER NOT NULL);
-- auth.ts（harness 登录流程）
CREATE TABLE logins(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,node_id TEXT NOT NULL,profile_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,lease TEXT,lease_until INTEGER DEFAULT 0,expires INTEGER NOT NULL,input TEXT DEFAULT '',cancel INTEGER DEFAULT 0);
-- notification-preferences.ts
CREATE TABLE notification_preferences(user_id TEXT PRIMARY KEY,body TEXT);
-- prompt-layers.ts（列的含义见那里的注释）
CREATE TABLE node_org_guides(node_id TEXT PRIMARY KEY,doc_id TEXT NOT NULL,version INTEGER NOT NULL,sha256 TEXT NOT NULL,
      body TEXT NOT NULL,fetched_at INTEGER NOT NULL,level INTEGER NOT NULL,problem TEXT,reported_at INTEGER NOT NULL,accepted INTEGER NOT NULL DEFAULT 1, self_reason TEXT, log_dropped INTEGER NOT NULL DEFAULT 0);
CREATE TABLE org_core(doc_id TEXT PRIMARY KEY,version INTEGER NOT NULL,sha256 TEXT NOT NULL,body TEXT NOT NULL,
      ok_at INTEGER NOT NULL,checked_at INTEGER NOT NULL,problem TEXT);
CREATE TABLE org_guide_log(id TEXT PRIMARY KEY,at INTEGER NOT NULL,source TEXT NOT NULL,node_id TEXT,doc_id TEXT NOT NULL,
      version INTEGER NOT NULL,level INTEGER NOT NULL,before_sha TEXT NOT NULL,after_sha TEXT NOT NULL,accepted INTEGER NOT NULL,note TEXT NOT NULL, kind INTEGER NOT NULL DEFAULT 0);
CREATE INDEX org_guide_log_at ON org_guide_log(at);
CREATE TABLE org_trusted(doc_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,
       at INTEGER NOT NULL,node_id TEXT);
CREATE TABLE user_prompt_prefs(user_id TEXT PRIMARY KEY,body TEXT NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE prompt_edit_log(id TEXT PRIMARY KEY,scope TEXT NOT NULL,scope_id TEXT NOT NULL,user_id TEXT NOT NULL,
      at INTEGER NOT NULL,action TEXT NOT NULL,summary TEXT NOT NULL,before TEXT,after TEXT);
CREATE INDEX prompt_edit_log_scope ON prompt_edit_log(scope,scope_id,at);
CREATE TABLE prompt_layer_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE prompt_apply_queue(session_id TEXT PRIMARY KEY,requested_at INTEGER NOT NULL,requested_by TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,tries INTEGER NOT NULL DEFAULT 0,job_id TEXT,note TEXT,updated INTEGER NOT NULL, batch TEXT);
CREATE TABLE prompt_apply_tokens(token_sha TEXT PRIMARY KEY,admin_id TEXT NOT NULL,set_sha TEXT NOT NULL,lim INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,used_at INTEGER);

-- 会话、对话条目、事件流
CREATE TABLE sessions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,data TEXT NOT NULL, request_id TEXT);
CREATE INDEX sessions_owner_task ON sessions(owner_id, json_extract(data,'$.task.id'));
CREATE UNIQUE INDEX sessions_owner_request ON sessions(owner_id, request_id) WHERE request_id IS NOT NULL;
CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL);
CREATE INDEX session_events ON events(session_id,seq);
CREATE TABLE items(id TEXT NOT NULL,session_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(session_id,id));
-- store/visible.ts 的 VISIBLE_ITEM_SQL（必须逐字相同，测试检查）
CREATE INDEX items_visible ON items(session_id) WHERE (json_extract(data,'$.kind')='user' OR json_extract(data,'$.category')='say' OR (id>='resident-state:' AND id<'resident-state;'));
CREATE TABLE attachments(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,path TEXT NOT NULL);
-- notifications.ts
CREATE TABLE notification_events(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL, user_id TEXT NOT NULL,
    kind TEXT NOT NULL, title TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL,
    action_required INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
    op TEXT NOT NULL DEFAULT 'create', item_key TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
    collapse_key TEXT NOT NULL DEFAULT '', expires INTEGER NOT NULL DEFAULT 0, close_state TEXT NOT NULL DEFAULT '',
    UNIQUE(event_key,user_id));
CREATE INDEX notification_user_seq ON notification_events(user_id,seq);
CREATE INDEX notification_user_item ON notification_events(user_id,item_key,seq);
-- ask-sidecar.ts。ask_sidecars.history（ADR-092）：之前的提问与回答（JSON AskHistoryEntry[]）；
-- sidecar_summaries.carried_job：带着摘要的主会话任务（那一轮成功后删除，失败时还回去）。
CREATE TABLE ask_sidecars(id TEXT PRIMARY KEY, parent TEXT NOT NULL,
      thread_id TEXT NOT NULL, root TEXT NOT NULL, created INTEGER NOT NULL,
      last_used INTEGER NOT NULL, closed INTEGER, history TEXT);
CREATE INDEX ask_sidecars_parent ON ask_sidecars(parent, root);
CREATE TABLE sidecar_summaries(id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      sidecar_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
      text TEXT NOT NULL, created INTEGER NOT NULL, carried_job TEXT);
CREATE INDEX sidecar_summaries_session ON sidecar_summaries(session_id, created);

-- 每一轮的任务、队列、恢复记录
CREATE TABLE jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,node_id TEXT NOT NULL,request_id TEXT NOT NULL,text TEXT NOT NULL,attachments TEXT NOT NULL,status TEXT NOT NULL,lease TEXT,lease_until INTEGER DEFAULT 0,cancel INTEGER DEFAULT 0,created INTEGER NOT NULL, context TEXT, terminal TEXT, origin TEXT, wake TEXT, preamble TEXT,UNIQUE(session_id,request_id));
CREATE UNIQUE INDEX one_active_job ON jobs(session_id) WHERE status IN ('queued','running');
CREATE INDEX jobs_session_created ON jobs(session_id,created);
CREATE TABLE job_operations(job_id TEXT PRIMARY KEY,data TEXT NOT NULL,result TEXT);
CREATE TABLE live_inputs(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,request_id TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,result TEXT,created INTEGER NOT NULL, context TEXT, source_job TEXT,UNIQUE(job_id,request_id));
CREATE TABLE live_sessions(session_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,data TEXT NOT NULL,updated INTEGER NOT NULL,stop INTEGER NOT NULL DEFAULT 0);
-- live.ts
CREATE TABLE live_restarts(session_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,profile_id TEXT NOT NULL,requested INTEGER NOT NULL,user_id TEXT NOT NULL);
-- background-tasks.ts
CREATE TABLE live_task_stops(session_id TEXT NOT NULL,task_id TEXT NOT NULL,node_id TEXT NOT NULL,requested INTEGER NOT NULL,user_id TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,task_id));
-- queue-merge.ts。how = 'carry'（ADR-085）：Harbor 的唤醒随主人消息的前言带进去（NULL：同类文字合并）；
-- moved = 被改指向的 trinity_callbacks 键，移除主人的消息时原样放回。
CREATE TABLE queue_merges(job_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,into_job TEXT,into_input TEXT,created INTEGER NOT NULL, how TEXT, moved TEXT);
-- queue-jump.ts。queue_jump_order：一个会话的每次插队，按先后（一条接一条插队）；queue_jumps 只留最新一条；
-- queue_jump_started（ADR-085）：已提升但还没认领的插队消息；queue_jump_order.why：为什么没能和前一条一起进（NULL：只是等前一轮）。
CREATE TABLE queue_jumps(session_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,stopped_job TEXT,created INTEGER NOT NULL);
CREATE TABLE queue_jump_order(job_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,stopped_job TEXT,created INTEGER NOT NULL, why TEXT);
CREATE TABLE queue_jump_started(job_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,created INTEGER NOT NULL);
-- native-append.ts。state：waiting（agent 拿着）· started（已读；own_turn = 前一轮结束后自成一轮）· completed
-- · returned（还回 Daisy 的队列）· removed（「移除」撤回）。read_at：agent 读到它的时间。
CREATE TABLE native_appends(job_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,input_id TEXT NOT NULL,into_job TEXT NOT NULL,state TEXT NOT NULL,own_turn INTEGER NOT NULL DEFAULT 0,auto INTEGER NOT NULL DEFAULT 0,withdraw INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL, read_at INTEGER);
-- app/runner-api.ts（恢复记录）
CREATE TABLE job_recoveries(job_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE job_recovery_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,event_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(job_id,event_id));
-- wake-delivery.ts
CREATE TABLE wakes(session_id TEXT NOT NULL,request_id TEXT NOT NULL,prompt TEXT NOT NULL,origin TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',created INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,request_id));
CREATE INDEX wakes_due ON wakes(status,next_at);
-- terminal.ts
CREATE TABLE terminal_output(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,part INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(job_id,part));
CREATE INDEX terminal_output_job ON terminal_output(job_id,seq);
CREATE TABLE terminal_input(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL);
-- shell.ts
CREATE TABLE shell_requests(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,node_id TEXT NOT NULL,command TEXT NOT NULL,cwd TEXT NOT NULL,status TEXT NOT NULL,result TEXT,lease TEXT,created INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE INDEX shell_requests_node ON shell_requests(node_id,status);
-- filesystem.ts
CREATE TABLE filesystem_requests(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,node_id TEXT NOT NULL,operation TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,result TEXT,lease TEXT,expires INTEGER NOT NULL);

-- 审批与提问
CREATE TABLE approvals(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,job_id TEXT NOT NULL,data TEXT NOT NULL);
-- native-approvals.ts
CREATE TABLE native_approvals(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL,taken_by TEXT,offered_to TEXT,thread_id TEXT);
-- approvals.ts
CREATE TABLE owner_approvals(id TEXT PRIMARY KEY,kind TEXT NOT NULL,session_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,job_id TEXT,request_id TEXT NOT NULL,data TEXT NOT NULL,
      status TEXT NOT NULL,decision TEXT,note TEXT,decided_by TEXT,decided_at INTEGER,
      created INTEGER NOT NULL,expires_at INTEGER,UNIQUE(session_id,request_id));
CREATE INDEX owner_approvals_owner ON owner_approvals(owner_id,status,created);
CREATE TABLE classifier_retries(session_id TEXT PRIMARY KEY,data TEXT NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE classifier_retry_items(session_id TEXT NOT NULL,item_id TEXT NOT NULL,created INTEGER NOT NULL,
      PRIMARY KEY(session_id,item_id));
CREATE TABLE approval_comments(aid TEXT NOT NULL,n INTEGER NOT NULL,at INTEGER NOT NULL,
      by_kind TEXT NOT NULL,by_id TEXT NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,
      request_id TEXT,PRIMARY KEY(aid,n));
CREATE UNIQUE INDEX approval_comments_req ON approval_comments(aid,by_id,request_id)
      WHERE request_id IS NOT NULL;

-- 定时、常驻 agent（scheduler.ts）。agent_schedules.report_at（ADR-065）：没送达的报告下次重试的时间（NULL：没有）；
-- resident_held_wakes（ADR-070）：常驻 agent 暂停时到达的结果，恢复运行时送一次；
-- kept_callbacks（ADR-083）：没能唤醒会话的回调，随下一轮带上，report_at 是下次尝试唤醒的时间（NULL：只等下一轮）。
CREATE TABLE agent_schedules(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, node_id TEXT NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL, next_at INTEGER,
    data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, report_at INTEGER);
CREATE INDEX agent_schedules_due ON agent_schedules(status, next_at);
CREATE INDEX agent_schedules_session ON agent_schedules(session_id, status);
CREATE INDEX agent_schedules_report ON agent_schedules(report_at) WHERE report_at IS NOT NULL;
CREATE TABLE resident_held_wakes(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, schedule_id TEXT NOT NULL,
    label TEXT NOT NULL, text TEXT NOT NULL, budget INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE INDEX resident_held_wakes_session ON resident_held_wakes(session_id, created);
CREATE TABLE kept_callbacks(
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, schedule_id TEXT NOT NULL,
    label TEXT NOT NULL, text TEXT NOT NULL, reason TEXT NOT NULL,
    budget INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    report_at INTEGER, created INTEGER NOT NULL);
CREATE INDEX kept_callbacks_session ON kept_callbacks(session_id, created);
CREATE INDEX kept_callbacks_due ON kept_callbacks(report_at) WHERE report_at IS NOT NULL;

-- 调用记录（call-chain.ts）
CREATE TABLE call_lineage(call_id TEXT PRIMARY KEY,root_id TEXT NOT NULL,depth INTEGER NOT NULL);
CREATE TABLE call_budgets(root_id TEXT PRIMARY KEY,calls INTEGER NOT NULL DEFAULT 0);

-- 审计记录
CREATE TABLE audit(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created INTEGER NOT NULL);
`;

/**
 * The steps, in order. Append only.
 */
/**
 * Version 2 (P1-05, packages/daisy/src/access/pin.ts): the PIN — one row with its
 * verifier (scrypt, its parameters inside; never the PIN), its lock state
 * (with the lock's start, so a clock that jumped cannot stretch it) and
 * when / through which entry it was last set and reset (D-36); and the PIN
 * grants, by the SHA-256 of the grant (never the grant) and the credential
 * holding it.
 */
const V2_PIN = `
CREATE TABLE pin(id INTEGER PRIMARY KEY CHECK(id=1),verifier TEXT,failures INTEGER NOT NULL DEFAULT 0,rounds INTEGER NOT NULL DEFAULT 0,locked_at INTEGER NOT NULL DEFAULT 0,locked_until INTEGER NOT NULL DEFAULT 0,set_at INTEGER,set_via TEXT,reset_at INTEGER,reset_via TEXT,updated INTEGER NOT NULL DEFAULT 0);
CREATE TABLE pin_grants(hash TEXT PRIMARY KEY,holder TEXT NOT NULL,expires INTEGER NOT NULL,created INTEGER NOT NULL);
`;

/**
 * Version 3 (P1-11, ADR-111, S-4): what each audit row records besides
 * who / action / target — trace id and depth (docs/contracts/trace.md),
 * who acted (with the AI's session and turn), face, channel, route,
 * object, outcome, reason, status. A side table keyed by the audit row's
 * id, not new columns: released code inserts into `audit` positionally
 * (tests/schema-compat.test.ts POSITIONAL). `jobs.trace`: the trace id of
 * the action that queued the turn.
 */
const V3_AUDIT = `
CREATE TABLE audit_context(audit_id TEXT PRIMARY KEY,trace_id TEXT NOT NULL,depth INTEGER NOT NULL DEFAULT 0,actor TEXT NOT NULL,session_id TEXT,job_id TEXT,face TEXT NOT NULL,channel TEXT NOT NULL,route TEXT,object TEXT,outcome TEXT NOT NULL DEFAULT 'ok',reason TEXT,status INTEGER);
CREATE INDEX audit_context_trace ON audit_context(trace_id);
CREATE INDEX audit_created ON audit(created);
ALTER TABLE jobs ADD COLUMN trace TEXT;
`;

/**
 * Version 4 (P2-03, ADR-114, docs/contracts/events.md): the event outlet's
 * outbox — one row per CloudEvents event, written in the same transaction
 * as the card it reports. `seq` is AUTOINCREMENT: never reused after a
 * sweep, so a subscriber's cursor stays meaningful (sqlite_sequence holds
 * the highest ever written). `open` = a 「出现」 event whose card is not
 * resolved yet (kept past the retention until then). `event_outbox_state`
 * keeps the highest sequence the sweep has removed: a cursor below it may
 * have missed events and is told to take a snapshot.
 */
const V4_EVENTS = `
CREATE TABLE event_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,type TEXT NOT NULL,subject TEXT NOT NULL,recipient TEXT NOT NULL,session_id TEXT NOT NULL DEFAULT '',time INTEGER NOT NULL,traceparent TEXT NOT NULL,data TEXT NOT NULL,open INTEGER NOT NULL DEFAULT 0);
CREATE INDEX event_outbox_recipient ON event_outbox(recipient,seq);
CREATE INDEX event_outbox_subject ON event_outbox(subject,seq);
CREATE INDEX event_outbox_time ON event_outbox(time) WHERE open=0;
CREATE TABLE event_outbox_state(id INTEGER PRIMARY KEY CHECK(id=1),pruned_through INTEGER NOT NULL DEFAULT 0);
`;

/**
 * Version 5 (P1-02b, ADR-108, gate G-2): the Runner's result journal
 * (turns/result-journal.ts) — until now its own file,
 * `<runner state>/result-journal/<node key>/results.sqlite` — lives here,
 * so the data directory has one database and a backup (VACUUM INTO)
 * covers it. Same rows as that file had, keyed by the node they belong to
 * (each node had its own file). `runner_journal_imports`: an old file that
 * was imported (once; it is then renamed to `results.sqlite.migrated`, not
 * deleted).
 */
export const V5_RUNNER_JOURNAL = `
CREATE TABLE runner_journal_jobs(node TEXT NOT NULL,id TEXT NOT NULL,lease TEXT NOT NULL,result TEXT,updated INTEGER NOT NULL,blocked TEXT,PRIMARY KEY(node,id));
CREATE TABLE runner_journal_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,node TEXT NOT NULL,id TEXT NOT NULL,job TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(node,id));
CREATE INDEX runner_journal_events_job ON runner_journal_events(node,job,seq);
CREATE TABLE runner_journal_imports(path TEXT PRIMARY KEY,node TEXT NOT NULL,jobs INTEGER NOT NULL,events INTEGER NOT NULL,imported_at INTEGER NOT NULL);
`;

/**
 * Version 6 (P4-01, ADR-120, docs/contracts/identity-card.md §6): the
 * contacts — other Daisies' identity cards the owner added (contacts/).
 * `id`: the identity number (base32 of the key's RFC 7638 thumbprint);
 * `thumbprint`: the same 32 bytes in base64url (a token's `kid`, its URN);
 * `x`: the Ed25519 public key; `card`: the verified compact JWS as
 * imported; `card_iat`: its `iat` (an older card never replaces a newer);
 * `whitelisted`: D-15; `added_via`: the channel that added it.
 */
const V6_CONTACTS = `
CREATE TABLE contacts(id TEXT PRIMARY KEY,thumbprint TEXT NOT NULL UNIQUE,x TEXT NOT NULL,name TEXT NOT NULL,note TEXT,addrs TEXT NOT NULL DEFAULT '[]',card TEXT NOT NULL,card_iat INTEGER NOT NULL,whitelisted INTEGER NOT NULL DEFAULT 0,added_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,added_via TEXT NOT NULL DEFAULT '');
`;

/**
 * Version 7 (P4-03, ADR-122, 总纲 5.2 / 5.6): call authorization (invoke/).
 * `invoke_audiences`: an agent's 开放范围 the owner set (no row: open to
 * all contacts); `invoke_audience_members`: its 指定人 (contacts' identity
 * numbers). `person` everywhere: a contact's identity number, or
 * `sub:<hash of issuer + whole sub>` for an external issuer's person, whose
 * issuer is kept in `issuer` (review M-2 / L-1). `invoke_grants`: 永久通过
 * — one per agent × person. `invoke_requests`: the cards (`id` without the
 * `call:` prefix), at most one pending per agent × person; `calls`: how
 * many calls joined it; `used_at`: a 仅本次 card's one call began.
 * `invoke_request_calls`: the calls waiting on a card (`raiser`: the one
 * that raised it — the one 仅本次 lets through, review M-3).
 */
const V7_INVOKE = `
CREATE TABLE invoke_audiences(agent_id TEXT PRIMARY KEY,open_to TEXT NOT NULL CHECK(open_to IN ('all','listed')),updated_at INTEGER NOT NULL);
CREATE TABLE invoke_audience_members(agent_id TEXT NOT NULL,person TEXT NOT NULL,added_at INTEGER NOT NULL,PRIMARY KEY(agent_id,person));
CREATE TABLE invoke_grants(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,person TEXT NOT NULL,contact_id TEXT,issuer TEXT,subject TEXT NOT NULL,name TEXT NOT NULL,granted_at INTEGER NOT NULL,request_id TEXT,UNIQUE(agent_id,person));
CREATE TABLE invoke_requests(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,agent_name TEXT NOT NULL,agent_session TEXT,person TEXT NOT NULL,contact_id TEXT,issuer TEXT,subject TEXT NOT NULL,actor TEXT,name TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,expires_at INTEGER NOT NULL,calls INTEGER NOT NULL DEFAULT 1,decision TEXT,note TEXT,decided_by TEXT,decided_at INTEGER,closed_why TEXT,used_at INTEGER);
CREATE UNIQUE INDEX invoke_requests_one_pending ON invoke_requests(agent_id,person) WHERE status='pending';
CREATE INDEX invoke_requests_created ON invoke_requests(created);
CREATE INDEX invoke_requests_person ON invoke_requests(agent_id,person,decided_at);
CREATE TABLE invoke_request_calls(ticket TEXT PRIMARY KEY,request_id TEXT NOT NULL,actor TEXT,created INTEGER NOT NULL,raiser INTEGER NOT NULL DEFAULT 0);
CREATE INDEX invoke_request_calls_request ON invoke_request_calls(request_id,created);
`;

/**
 * Version 8 (P4-04, ADR-123, 总纲 5.8, a2a-usage.md §7 / §12): the A2A
 * server's visiting conversations (a2a/).
 * `a2a_contexts`: one per caller × agent conversation (`caller`: who owns
 * it — `contact:<identity number>` or the external issuer's
 * `sub:<issuer>|<subject>`); `active_at` for the 7-day idle reclaim.
 * `a2a_tasks`: one per request (a turn); `state` a TASK_STATE_*;
 * `status_message` / `artifacts` / `metadata` the task's JSON parts;
 * `trace_id` / `depth` (trace.md). `a2a_messages`: a task's history —
 * the caller's messages and the agent's input-required questions.
 * `a2a_message_ids`: each caller's `messageId` on an agent, its digest
 * and task (resends; kept until the conversation is reclaimed).
 * `seen_token_ids`: P4-01 review — a contact's cross-Daisy token is good
 * once: its `jti` is kept until `exp` + the clock skew.
 */
const V8_A2A = `
CREATE TABLE a2a_contexts(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,caller TEXT NOT NULL,created INTEGER NOT NULL,active_at INTEGER NOT NULL);
CREATE INDEX a2a_contexts_active ON a2a_contexts(active_at);
CREATE TABLE a2a_tasks(id TEXT PRIMARY KEY,context_id TEXT NOT NULL,agent_id TEXT NOT NULL,caller TEXT NOT NULL,actor TEXT,state TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'ask',via TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,status_message TEXT,artifacts TEXT NOT NULL DEFAULT '[]',metadata TEXT,trace_id TEXT NOT NULL,depth INTEGER NOT NULL DEFAULT 1);
CREATE INDEX a2a_tasks_caller ON a2a_tasks(agent_id,caller,created);
CREATE INDEX a2a_tasks_context ON a2a_tasks(context_id,created);
CREATE INDEX a2a_tasks_state ON a2a_tasks(state);
CREATE INDEX a2a_tasks_trace ON a2a_tasks(trace_id);
CREATE TABLE a2a_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,context_id TEXT NOT NULL,role TEXT NOT NULL,message_id TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL);
CREATE INDEX a2a_messages_task ON a2a_messages(task_id,seq);
CREATE INDEX a2a_messages_context ON a2a_messages(context_id);
CREATE TABLE a2a_message_ids(agent_id TEXT NOT NULL,caller TEXT NOT NULL,message_id TEXT NOT NULL,digest TEXT NOT NULL,task_id TEXT NOT NULL,context_id TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(agent_id,caller,message_id));
CREATE INDEX a2a_message_ids_context ON a2a_message_ids(context_id);
CREATE TABLE seen_token_ids(issuer TEXT NOT NULL,jti TEXT NOT NULL,until INTEGER NOT NULL,PRIMARY KEY(issuer,jti));
CREATE INDEX seen_token_ids_until ON seen_token_ids(until);
`;

/**
 * P4-05 (ADR-124): 问与办. `agent_act`: per agent, whether 办 is accepted
 * and the permission mode it runs with (NULL: the session's own); no row =
 * the defaults (accepted, auto where the harness has it). `a2a_turns`: the
 * turns a task started (a read-only branch, the main line read-only, the
 * main line 办) and the permission mode the Runner gives that turn.
 */
const V9_ASK_ACT = `
CREATE TABLE agent_act(agent_id TEXT PRIMARY KEY,act INTEGER NOT NULL,permission_mode TEXT,updated_at INTEGER NOT NULL);
CREATE TABLE a2a_turns(job_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,agent_id TEXT NOT NULL,session_id TEXT NOT NULL,main_id TEXT NOT NULL,kind TEXT NOT NULL,permission_mode TEXT,created INTEGER NOT NULL);
CREATE INDEX a2a_turns_task ON a2a_turns(task_id);
CREATE INDEX a2a_turns_main ON a2a_turns(main_id,kind);
`;

/**
 * Version 10 (P4-08, ADR-127, a2a-usage.md §15, trace.md §3): this Daisy
 * calling others — the A2A client tools.
 * `jobs.depth`: the turn's depth on its trace (0: the owner's own action, a
 * timer; an A2A task's turn: the depth the call carried) — an AI's call
 * goes out at depth + 1. `wakes.trace` / `wakes.depth`: a wake that hands
 * an answer back continues the caller's trace at the caller's depth.
 * `a2a_calls`: one per task asked of another Daisy's agent — the remote's
 * `context_id` / `task_id` (opaque), the exact message last sent
 * (`message`: resent byte for byte, same messageId, after a network
 * failure), its state, the answer, the trace and depth, the polling
 * schedule, and what the AI was already told (`told`). Counted with
 * `a2a_tasks` per trace (64, trace.md §5). `a2a_tls_pins`: a contact's
 * self-signed certificate, pinned on first use per origin, until the
 * owner imports a newer card of theirs (`card_iat`).
 */
const V10_A2A_CLIENT = `
ALTER TABLE jobs ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wakes ADD COLUMN trace TEXT;
ALTER TABLE wakes ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
CREATE TABLE a2a_calls(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,job_id TEXT,contact_id TEXT NOT NULL,contact_name TEXT NOT NULL,agent_id TEXT NOT NULL,agent_name TEXT NOT NULL,mode TEXT NOT NULL,message_id TEXT NOT NULL,message TEXT NOT NULL,extensions TEXT NOT NULL DEFAULT '[]',iface TEXT,addr TEXT,context_id TEXT,task_id TEXT,state TEXT NOT NULL,reason TEXT,status_text TEXT,answer TEXT,files TEXT,trace_id TEXT NOT NULL,depth INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,next_at INTEGER,delay INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,told TEXT,wakes INTEGER NOT NULL DEFAULT 0);
CREATE INDEX a2a_calls_session ON a2a_calls(session_id,created);
CREATE INDEX a2a_calls_trace ON a2a_calls(trace_id);
CREATE INDEX a2a_calls_due ON a2a_calls(next_at);
CREATE INDEX a2a_calls_thread ON a2a_calls(session_id,contact_id,agent_id,created);
CREATE TABLE a2a_tls_pins(contact_id TEXT NOT NULL,origin TEXT NOT NULL,sha256 TEXT NOT NULL,card_iat INTEGER NOT NULL,first_seen INTEGER NOT NULL,PRIMARY KEY(contact_id,origin));
`;

/**
 * P4-06 (ADR-125): 公开 agent. One row per session made public (5.2: the
 * agent id is the session id); no row = private. Taking it back, or
 * deleting the session, removes the row (and the agent's grants, range,
 * cards, 办 settings — InvokeAccess.forgetAgent and its listeners).
 */
const V11_PUBLIC_AGENTS = `
CREATE TABLE public_agents(session_id TEXT PRIMARY KEY,since INTEGER NOT NULL,by TEXT NOT NULL);
`;

/**
 * P4-07 (ADR-126): resident agents. `resident_agents`: one configuration
 * each (the JSON `data`: harness, workspace, identity, layered prompt,
 * permission mode, directories, tools, limits, what to do with an
 * operation auto mode still asks about) and its state (running, paused,
 * closed). `resident_sessions`: the dedicated session of each visiting
 * conversation (A2A contextId) — closed with the agent, deleted when the
 * conversation is reclaimed.
 */
const V12_RESIDENTS = `
CREATE TABLE resident_agents(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,data TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,paused_at INTEGER,closed_at INTEGER);
CREATE TABLE resident_sessions(agent_id TEXT NOT NULL,context_id TEXT NOT NULL,session_id TEXT NOT NULL,caller TEXT NOT NULL,created INTEGER NOT NULL,last_at INTEGER NOT NULL,closed_at INTEGER,PRIMARY KEY(agent_id,context_id));
CREATE INDEX resident_sessions_session ON resident_sessions(session_id);
`;

/**
 * P4-12 (ADR-132, token.md §7): `daisy token` — the record of each token
 * signed for a third-party A2A client (never the token itself): its `jti`,
 * who it stands for (`subject`: a contact's URN or this Daisy's own;
 * `contact_id` null for `me`), the note, when it runs out, whether and why
 * it was revoked, when it was last used. The verifier reads the row on
 * every request (token.md §4.1 step 7).
 */
const V13_VISITOR_TOKENS = `
CREATE TABLE visitor_tokens(jti TEXT PRIMARY KEY,subject TEXT NOT NULL,contact_id TEXT,name TEXT NOT NULL,note TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_by TEXT NOT NULL,revoked_at INTEGER,revoked_why TEXT,last_used_at INTEGER);
CREATE INDEX visitor_tokens_contact ON visitor_tokens(contact_id);
`;

/**
 * P5-03 (ADR-142, 总纲 7.6 「配对」, 5.13 「配对过的设备」): the owner's
 * paired devices — one row each, never the device credential itself
 * (`secret_hash`: its SHA-256, hex; 256 random bits need no slow hash).
 * `face`: where it was paired and may trade its credential (the outside
 * face). `last_used_at` / `last_ip`: the last trade or request (at most
 * once a minute). `revoked_why`: owner, self, pin_reset. Revoked and
 * expired rows are kept 30 days for the list.
 */
const V14_DEVICES = `
CREATE TABLE devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,secret_hash TEXT NOT NULL,face TEXT NOT NULL,created_at INTEGER NOT NULL,created_by TEXT NOT NULL,last_used_at INTEGER,last_ip TEXT,user_agent TEXT,revoked_at INTEGER,revoked_why TEXT,revoked_by TEXT);
CREATE UNIQUE INDEX devices_secret ON devices(secret_hash);
`;

/**
 * P6-11 (ADR-156): which agents this machine's node has been given its
 * 「主机登录」 identity for (app/bootstrap.ts `ensureHostLogins`, every
 * start). A harness that appears later — an extra ACP harness file, a new
 * built-in after an update — gets one at the next start; one the owner
 * deleted is not made again. Filled from the identities there are: an agent
 * with any identity on a node counts as given.
 */
const V15_HOST_LOGINS = `
CREATE TABLE host_login_agents(node_id TEXT NOT NULL,agent TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(node_id,agent));
INSERT OR IGNORE INTO host_login_agents(node_id,agent,created_at)
  SELECT DISTINCT node_id,json_extract(data,'$.agent'),CAST(strftime('%s','now') AS INTEGER)*1000 FROM profiles
  WHERE json_valid(data) AND json_extract(data,'$.agent') IS NOT NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, note: "完整结构（D-06：干净起点）", sql: V1 },
  { version: 2, note: "PIN: check value and lockout, PIN grants (P1-05)", sql: V2_PIN },
  { version: 3, note: "Audit context and trace ids, jobs' trace ids (P1-11)", sql: V3_AUDIT },
  { version: 4, note: "Event outlet outbox (P2-03)", sql: V4_EVENTS },
  { version: 5, note: "Runner result journal moved into daisy.sqlite (P1-02b)", sql: V5_RUNNER_JOURNAL },
  { version: 6, note: "Mutually recognised contacts (identity cards) and allowlist (P4-01)", sql: V6_CONTACTS },
  { version: 7, note: "Call authorization: openness, chosen people, standing grants, call request cards (P4-03)", sql: V7_INVOKE },
  { version: 8, note: "A2A server: incoming contexts, tasks, history, messageId; cross-Daisy tokens used once (P4-04)", sql: V8_A2A },
  { version: 9, note: "Ask and act: whether each agent allows act, act permission mode; turns started by incoming tasks (P4-05)", sql: V9_ASK_ACT },
  { version: 10, note: "A2A client: outgoing calls, trace depth of turns and wakes, first-use trust of peer certificates (P4-08)", sql: V10_A2A_CLIENT },
  { version: 11, note: "Public agents: which sessions are public (P4-06)", sql: V11_PUBLIC_AGENTS },
  { version: 12, note: "Resident agents: configuration and state, a dedicated session per incoming context (P4-07)", sql: V12_RESIDENTS },
  { version: 13, note: "Issue records of tokens for third-party A2A clients (daisy token) (P4-12)", sql: V13_VISITOR_TOKENS },
  { version: 14, note: "Paired devices: records, device credential check values, last use, revocation (P5-03)", sql: V14_DEVICES },
  { version: 15, note: "Agents each node already gave a host-login identity profile (P6-11)", sql: V15_HOST_LOGINS },
];

/** The structure version this code writes and expects. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * Statements that take something away from old code: dropping or renaming
 * a table, column or view. A step with any of these must set `breaking`.
 * (DROP INDEX / DROP TRIGGER are allowed when the same step creates the
 * same name again — tests/schema-compat.test.ts.)
 */
export function destructiveStatements(sql: string): string[] {
  const code = sql.replace(/--[^\n]*/g, "");
  return [
    ...code.matchAll(
      /\b(DROP\s+(?:TABLE|COLUMN|VIEW)\b|RENAME\s+(?:TO|COLUMN)\b|ALTER\s+TABLE\s+\w+\s+DROP\b)/gi,
    ),
  ].map((m) => m[1].replace(/\s+/g, " ").toUpperCase());
}
