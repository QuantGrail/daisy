/**
 * P4-12 (总纲 5.10 「设置：三种 agent 与开放范围、互认的名片与白名单」 and
 * 「工作台：待批准的调用」, 5.11, ADR-132): the 「对外」 pages of the local
 * web page — every one of them a command too (`daisy request / agent /
 * grant / contact / token / call`).
 *
 * The 「调用授权」 group is `daisy:grant` throughout. D-40 ① (phase-4
 * gate): reading on this page takes no PIN (only the command line's reads
 * do, `PIN_ON_CLI`) — the lists load as the area opens — and every change
 * asks for the PIN (`usePin`; a grant held a few minutes
 * covers the next ones). The AI's credential reads none of it (it has no
 * daisy:grant). 「我的 AI 调用了谁」 is the owner's reading too.
 */
import { shownName } from "@daisy-ai/contracts";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import type { DaisyClient } from "@daisy-ai/client";
import {
  api,
  RESIDENT_APPROVALS,
  type AgentAskAct,
  type AgentAudience,
  type AgentOverview,
  type CardInspection,
  type Catalog,
  type Contact,
  type IdentityCardView,
  type InvokeGrant,
  type InvokeRequest,
  type OutgoingCall,
  type ResidentAgentView,
  type ResidentConversation,
  type Session,
  type VisitorToken,
} from "@daisy-ai/contracts";
import { Badge, Button, ErrorBox, Field, Text } from "./primitives";
import { useDaisyTheme } from "./theme";
import { useDaisyTime } from "./host";
import { PinCancelled, usePin } from "./pin";
import { copyText } from "./clipboard";
import { PublicAgentSection } from "./session-settings";
import { useT } from "./i18n";
import {
  agentKinds,
  decisions,
  isolationCaveat,
  tokenTtls,
  agentKindLabel,
  bashAllowed,
  callerLine,
  grouped,
  rangeLabel,
  tokenForLabel,
  tokenStateLabel,
  waitingLine,
} from "./sharing-view";

// ── shared pieces ─────────────────────────────────────────────────────────

/** Run `f` with a PIN grant (asked for when none is held); a refused grant is forgotten. */
function usePinCall() {
  const pin = usePin();
  return useCallback(
    async <T,>(why: string, f: (grant: string) => Promise<T>): Promise<T> => {
      const g = await pin.grant(why);
      try {
        return await f(g);
      } catch (e: any) {
        if (e?.code === "pin_required" || e?.code === "pin_changed") pin.forget();
        throw e;
      }
    },
    [pin],
  );
}
const quiet = (e: unknown) => e instanceof PinCancelled;

/** A list loaded on mount and on `reload`, its error in words. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [value, setValue] = useState<T | null>(null),
    [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      setValue(await load());
      setError("");
    } catch (e: any) {
      if (!quiet(e)) setError(e?.message ?? String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { value, error, reload };
}

/** One action's busy flag, error and notice. */
function useAction() {
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const run = async (key: string, f: () => Promise<string | void>) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const n = await f();
      if (n) setNotice(n);
    } catch (e: any) {
      if (!quiet(e)) setError(e?.message ?? String(e));
    } finally {
      setBusy("");
    }
  };
  return { busy, error, notice, run, setError, setNotice };
}

function Section({
  title,
  hint,
  testID,
  children,
  right,
}: React.PropsWithChildren<{ title: string; hint?: string; testID?: string; right?: React.ReactNode }>) {
  const { s } = useDaisyTheme();
  return (
    <View style={[s.card, { gap: 10 }]} testID={testID}>
      <View style={[s.row, { flexWrap: "wrap", alignItems: "flex-start" }]}>
        <View style={{ flex: 1, minWidth: 200, gap: 4 }}>
          <Text style={s.h3}>{title}</Text>
          {hint ? <Text style={[s.muted, { fontSize: 12 }]}>{hint}</Text> : null}
        </View>
        {right}
      </View>
      {children}
    </View>
  );
}

function Notice({ text }: { text: string }) {
  const { C } = useDaisyTheme();
  return text ? <Text style={{ fontSize: 12, color: C.accent }}>{text}</Text> : null;
}

/** A choice among a few (chips). */
function Choice<T extends string>({
  value,
  options,
  onChange,
  testID,
}: {
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  testID?: string;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }} testID={testID}>
      {options.map((o) => (
        <Button
          key={o.value}
          testID={testID ? `${testID}-${o.value}` : undefined}
          variant={value === o.value ? "soft" : "outline"}
          onPress={() => onChange(o.value)}
        >
          {value === o.value ? `● ${o.label}` : o.label}
        </Button>
      ))}
    </View>
  );
}

function Check({ on, label, onChange, testID }: { on: boolean; label: string; onChange: (on: boolean) => void; testID?: string }) {
  const { C } = useDaisyTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      onPress={() => onChange(!on)}
      style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", paddingVertical: 4 }}
    >
      <Text style={{ fontSize: 15, color: on ? C.accent : C.muted }}>{on ? "☑" : "☐"}</Text>
      <Text style={{ flex: 1, fontSize: 13, color: C.ink }}>{label}</Text>
    </Pressable>
  );
}

/** An identity number for people to compare, in groups of four. */
function IdNumber({ id, testID }: { id: string; testID?: string }) {
  const { C } = useDaisyTheme();
  return (
    <Text selectable testID={testID} style={{ fontFamily: "monospace", fontSize: 13, color: C.ink, letterSpacing: 0.5 }}>
      {grouped(id)}
    </Text>
  );
}

function Row({ children, testID }: React.PropsWithChildren<{ testID?: string }>) {
  const { C } = useDaisyTheme();
  return (
    <View testID={testID} style={{ gap: 6, padding: 10, borderWidth: 1, borderColor: C.line, borderRadius: 10 }}>
      {children}
    </View>
  );
}

// ── the area ──────────────────────────────────────────────────────────────

/**
 * 设置 › 对外: the agents others may call and who may, the call cards, the
 * standing grants, the contacts and the whitelist, tokens for third-party
 * clients — behind the PIN — and what my AIs called.
 */
export function SharingSettings({ client, catalog }: { client: DaisyClient; catalog: Catalog }) {
  const { s } = useDaisyTheme();
  const t = useT();
  const [rev, setRev] = useState(0);
  const changed = useCallback(() => setRev((r) => r + 1), []);
  return (
    <View style={{ gap: 16 }} testID="settings-sharing">
      <Section
        title={t("ui-sharing.title")}
        hint={t("ui-sharing.hint")}
      >
        <Text style={[s.muted, { fontSize: 12 }]} testID="sharing-pin-note">
          {t("ui-sharing.pinNote")}
        </Text>
      </Section>
      <CallRequestList client={client} rev={rev} onChanged={changed} />
      <AgentsSection client={client} catalog={catalog} rev={rev} onChanged={changed} />
      <GrantsSection client={client} rev={rev} onChanged={changed} />
      <ContactsSection client={client} rev={rev} onChanged={changed} />
      <TokensSection client={client} rev={rev} onChanged={changed} />
      <OutgoingCallsSection client={client} />
    </View>
  );
}

// ── 待批准的调用 ───────────────────────────────────────────────────────────

export function CallRequestList({
  client,
  rev = 0,
  onChanged,
}: {
  client: DaisyClient;
  rev?: number;
  onChanged?: () => void;
}) {
  const t = useT();
  const [decided, setDecided] = useState(false);
  const list = useLoad(
    () =>
      client
        .call(api.invoke.requestList, { query: { status: decided ? "decided" : "pending", limit: 100 } })
        .then((r) => r.requests),
    [client, rev, decided],
  );
  return (
    <Section
      title={t("ui-sharing.requests.title")}
      hint={t("ui-sharing.requests.hint")}
      testID="sharing-requests"
      right={
        <View style={{ flexDirection: "row", gap: 4 }}>
          <Button variant="ghost" onPress={() => void list.reload()} testID="sharing-requests-refresh">
            {t("ui-sharing.refresh")}
          </Button>
          <Button variant="ghost" onPress={() => setDecided(!decided)} testID="sharing-requests-toggle">
            {decided ? t("ui-sharing.requests.showPending") : t("ui-sharing.requests.showDecided")}
          </Button>
        </View>
      }
    >
      <ErrorBox text={list.error} />
      {list.value && !list.value.length ? (
        <Text style={{ fontSize: 13 }} testID="sharing-requests-empty">
          {decided ? t("ui-sharing.requests.emptyDecided") : t("ui-sharing.requests.empty")}
        </Text>
      ) : null}
      {(list.value ?? []).map((r) => (
        <CallRequestCard
          key={r.id}
          client={client}
          request={r}
          onDecided={() => {
            void list.reload();
            onChanged?.();
          }}
        />
      ))}
    </Section>
  );
}

export function CallRequestCard({
  client,
  request: r,
  onDecided,
}: {
  client: DaisyClient;
  request: InvokeRequest;
  onDecided: (next: InvokeRequest) => void;
}) {
  const { C, s } = useDaisyTheme();
  const when = useDaisyTime();
  const t = useT();
  const pc = usePinCall();
  const a = useAction();
  const [note, setNote] = useState("");
  const tid = `request-${r.id.replace(/^call:/, "")}`;
  return (
    <Row testID={tid}>
      <Text style={{ fontWeight: "600", color: C.ink }}>
        {t("ui-sharing.request.heading", { caller: r.caller.name, agent: r.agent.name })}
      </Text>
      <Text style={[s.muted, { fontSize: 12 }]} testID={`${tid}-caller`}>
        {callerLine(r.caller)}
      </Text>
      <Text style={{ fontSize: 12, color: C.ink }} testID={`${tid}-waiting`}>
        {waitingLine(r)}
      </Text>
      <Text style={[s.muted, { fontSize: 11 }]}>
        {t("ui-sharing.request.raised", { at: `${when.date(r.created)} ${when.time(r.created)}` })} ·{" "}
        {r.status === "pending"
          ? t("ui-sharing.request.expires", { date: when.date(r.expiresAt) })
          : r.decision
            ? t("ui-sharing.request.decided", { decision: r.decision.label })
            : (r.closedWhy ?? r.status)}
      </Text>
      {r.status === "pending" ? (
        <>
          <Field label={t("ui-sharing.request.note")} value={note} onChange={setNote} testID={`${tid}-note`} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {decisions().map((d) => (
              <Button
                key={d.key}
                testID={`${tid}-${d.key}`}
                variant={d.key === "reject" ? "danger" : d.key === "always" ? "primary" : "soft"}
                busy={a.busy === d.key}
                disabled={!!a.busy}
                onPress={() =>
                  void a.run(d.key, async () => {
                    const next = await pc(t("ui-sharing.request.pinWhy", { decision: d.label }), (g) =>
                      client.call(
                        api.invoke.requestDecide,
                        { params: { rid: r.id }, body: { decision: d.key, ...(note.trim() ? { note: note.trim() } : {}) } },
                        { pinGrant: g },
                      ),
                    );
                    onDecided(next);
                  })
                }
              >
                {d.label}
              </Button>
            ))}
          </View>
          <Text style={[s.muted, { fontSize: 11 }]}>
            {t("ui-sharing.request.decisionsHelp", { list: decisions()
              .map((d) => t("ui-sharing.request.decisionHelp", { label: d.label, hint: d.hint }))
              .join(t("ui-sharing.listSep")) })}
          </Text>
        </>
      ) : null}
      <ErrorBox text={a.error} />
    </Row>
  );
}

/** The workbench's line: how many call cards wait (no PIN: the 「审批」 list carries them). */
export function useCallRequestCount(client: DaisyClient): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let on = true;
    const read = () =>
      client
        .call(api.approvals.list, { query: { status: "pending" } })
        .then((r) => {
          if (on) setN(r.items.filter((x) => x.kind === "call" && x.status === "pending").length);
        })
        .catch(() => {});
    void read();
    const t = setInterval(read, 15000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [client]);
  return n;
}

// ── 我的 agent ─────────────────────────────────────────────────────────────

function AgentsSection({
  client,
  catalog,
  rev,
  onChanged,
}: {
  client: DaisyClient;
  catalog: Catalog;
  rev: number;
  onChanged: () => void;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const list = useLoad(
    () => client.call(api.agents.agentList, {}).then((r) => r.agents),
    [client, rev],
  );
  const [openId, setOpenId] = useState<string | null>(null),
    [adding, setAdding] = useState<"" | "public" | "resident">("");
  return (
    <Section
      title={t("ui-sharing.agents.title")}
      hint={t("ui-sharing.agents.hint")}
      testID="sharing-agents"
    >
      <View style={{ gap: 4 }}>
        {agentKinds().map((k) => (
          <Text key={k.kind} style={{ fontSize: 12, color: C.ink }}>
            <Text style={{ fontWeight: "600" }}>{k.title}</Text>
            {t("ui-sharing.agents.kindLine", { line: k.line })}
          </Text>
        ))}
      </View>
      <ErrorBox text={list.error} />
      {list.value && !list.value.length ? (
        <Text style={{ fontSize: 13 }} testID="sharing-agents-empty">
          {t("ui-sharing.agents.empty")}
        </Text>
      ) : null}
      {(list.value ?? []).map((a) => (
        <AgentRow
          key={a.id}
          client={client}
          agent={a}
          open={openId === a.id}
          onToggle={() => setOpenId(openId === a.id ? null : a.id)}
          onChanged={() => {
            void list.reload();
            onChanged();
          }}
        />
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button variant="soft" testID="sharing-agents-add-public" onPress={() => setAdding(adding === "public" ? "" : "public")}>
          {t("ui-sharing.agents.addPublic")}
        </Button>
        <Button variant="soft" testID="sharing-agents-add-resident" onPress={() => setAdding(adding === "resident" ? "" : "resident")}>
          {t("ui-sharing.agents.addResident")}
        </Button>
      </View>
      {adding === "public" ? (
        <MakePublic
          client={client}
          exclude={(list.value ?? []).map((a) => a.id)}
          onChanged={() => {
            void list.reload();
            onChanged();
          }}
        />
      ) : null}
      {adding === "resident" ? (
        <ResidentCreate
          client={client}
          catalog={catalog}
          onCreated={(id) => {
            setAdding("");
            setOpenId(id);
            void list.reload();
            onChanged();
          }}
        />
      ) : null}
      <Text style={[s.muted, { fontSize: 11 }]}>
        {t("ui-sharing.agents.footer")}
      </Text>
    </Section>
  );
}

function AgentRow({
  client,
  agent: a,
  open,
  onToggle,
  onChanged,
}: {
  client: DaisyClient;
  agent: AgentOverview;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  return (
    <Row testID={`agent-${a.id}`}>
      <Pressable onPress={onToggle} accessibilityRole="button" testID={`agent-${a.id}-toggle`}>
        <View style={[s.row, { flexWrap: "wrap" }]}>
          <Text style={{ flex: 1, minWidth: 160, fontWeight: "600", color: C.ink }}>
            {open ? "▾" : "▸"} {a.name}
          </Text>
          <Badge text={agentKindLabel(a)} color={a.kind === "public" ? C.accent : C.green} />
        </View>
        <Text style={[s.muted, { fontSize: 12 }]}>
          {rangeLabel(a)}
          {a.act === false ? t("ui-sharing.agent.noAct") : a.act ? t("ui-sharing.agent.act") : ""}
          {a.pending ? t("ui-sharing.agent.pending", { count: a.pending }) : ""}
          {a.grants ? t("ui-sharing.agent.grants", { count: a.grants }) : ""}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ gap: 12, paddingTop: 6 }}>
          {a.state !== "closed" ? <AudienceEditor client={client} agentId={a.id} onChanged={onChanged} /> : null}
          {a.kind === "public" ? <AskActEditor client={client} agentId={a.id} onChanged={onChanged} /> : null}
          {a.kind === "public" && a.sessionId ? (
            <View style={{ gap: 6 }}>
              <PublicAgentSection client={client} sessionId={a.sessionId} />
              <Button variant="ghost" onPress={onChanged}>
                {t("ui-sharing.refreshList")}
              </Button>
            </View>
          ) : null}
          {a.kind === "resident" ? <ResidentEditor client={client} agentId={a.id} onChanged={onChanged} /> : null}
        </View>
      ) : null}
    </Row>
  );
}

function AudienceEditor({ client, agentId, onChanged }: { client: DaisyClient; agentId: string; onChanged: () => void }) {
  const { s } = useDaisyTheme();
  const t = useT();
  const pc = usePinCall();
  const a = useAction();
  const cur = useLoad(
    () => client.call(api.invoke.audienceShow, { params: { aid: agentId } }),
    [client, agentId],
  );
  const contacts = useLoad(
    () => client.call(api.contacts.contactList, {}).then((r) => r.contacts),
    [client],
  );
  const [openTo, setOpenTo] = useState<"all" | "listed" | null>(null),
    [listed, setListed] = useState<string[] | null>(null);
  const v: AgentAudience | null = cur.value;
  const to = openTo ?? v?.openTo ?? null;
  const names = listed ?? v?.listed.map((p) => p.key) ?? [];
  const dirty = !!v && (to !== v.openTo || JSON.stringify([...names].sort()) !== JSON.stringify(v.listed.map((p) => p.key).sort()));
  return (
    <View style={{ gap: 6 }} testID={`agent-${agentId}-audience`}>
      <Text style={s.label}>{t("ui-sharing.audience.title")}</Text>
      <ErrorBox text={cur.error || contacts.error} />
      <Choice
        testID={`agent-${agentId}-audience-to`}
        value={to}
        onChange={setOpenTo}
        options={[
          { value: "all", label: t("ui-sharing.audience.all") },
          { value: "listed", label: t("ui-sharing.audience.listed") },
        ]}
      />
      {to === "listed" ? (
        <View>
          {(contacts.value ?? []).map((c) => (
            <Check
              key={c.id}
              testID={`agent-${agentId}-audience-${c.id.slice(0, 8)}`}
              on={names.includes(c.id)}
              label={t("ui-sharing.audience.contact", { name: c.name, id: c.grouped.slice(0, 19) })}
              onChange={(on) => setListed(on ? [...names, c.id] : names.filter((x) => x !== c.id))}
            />
          ))}
          {contacts.value && !contacts.value.length ? <Text style={[s.muted, { fontSize: 12 }]}>{t("ui-sharing.contacts.empty")}</Text> : null}
        </View>
      ) : null}
      <Text style={[s.muted, { fontSize: 11 }]}>
        {t("ui-sharing.audience.narrowNote")}
      </Text>
      <View style={[s.row, { justifyContent: "flex-end" }]}>
        <Button
          variant="soft"
          testID={`agent-${agentId}-audience-save`}
          disabled={!dirty}
          busy={a.busy === "save"}
          onPress={() =>
            void a.run("save", async () => {
              const r = await pc(t("ui-sharing.audience.pinWhy"), (g) =>
                client.call(
                  api.invoke.audienceSet,
                  { params: { aid: agentId }, body: { openTo: to!, ...(to === "listed" ? { listed: names } : {}) } },
                  { pinGrant: g },
                ),
              );
              setOpenTo(null);
              setListed(null);
              await cur.reload();
              onChanged();
              return r.stopped ? t("ui-sharing.savedStoppedCalls", { count: r.stopped }) : t("ui-sharing.saved");
            })
          }
        >
          {t("ui-sharing.audience.save")}
        </Button>
      </View>
      <ErrorBox text={a.error} />
      <Notice text={a.notice} />
    </View>
  );
}

function AskActEditor({ client, agentId, onChanged }: { client: DaisyClient; agentId: string; onChanged: () => void }) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const pc = usePinCall();
  const a = useAction();
  const cur = useLoad(
    () => client.call(api.invoke.actShow, { params: { aid: agentId } }),
    [client, agentId],
  );
  const v: AgentAskAct | null = cur.value;
  const save = (body: { act?: boolean; permissionMode?: string }, what: string) =>
    void a.run(what, async () => {
      const r = await pc(t("ui-sharing.act.pinWhy"), (g) =>
        client.call(api.invoke.actSet, { params: { aid: agentId }, body }, { pinGrant: g }),
      );
      await cur.reload();
      onChanged();
      return r.withdrawn ? t("ui-sharing.act.savedWithdrawn", { count: r.withdrawn }) : t("ui-sharing.saved");
    });
  if (!v) return <ErrorBox text={cur.error} />;
  const ask =
    v.ask.readOnly === "none"
      ? t("ui-sharing.ask.none")
      : t("ui-sharing.ask.line", { 
          how: v.ask.ranOn === "branch" ? t("ui-sharing.ask.branch") : t("ui-sharing.ask.main"),
          weak: v.ask.readOnly === "weak" ? t("ui-sharing.ask.weak") : "",
          why: v.ask.why ?? "",
         });
  return (
    <View style={{ gap: 6 }} testID={`agent-${agentId}-act`}>
      <Text style={s.label}>{t("ui-sharing.act.title")}</Text>
      <Text style={{ fontSize: 12, color: C.ink }}>{ask}</Text>
      <Check
        testID={`agent-${agentId}-act-toggle`}
        on={v.act}
        label={t("ui-sharing.act.toggle")}
        onChange={(on) => save({ act: on }, "act")}
      />
      {v.act ? (
        <>
          <Text style={[s.muted, { fontSize: 12 }]}>{t("ui-sharing.act.modeLabel")}</Text>
          <Choice
            testID={`agent-${agentId}-act-mode`}
            value={v.permissionMode ?? "session"}
            onChange={(m) => save({ permissionMode: m }, "mode")}
            options={[{ value: "session", label: t("ui-sharing.act.followSession") }, ...v.modes.map((m) => ({ value: m, label: m }))]}
          />
        </>
      ) : null}
      <ErrorBox text={a.error} />
      <Notice text={a.notice} />
    </View>
  );
}

/** 「把一个会话设为公开」: pick a session; P4-06's section does the rest (会串话, PIN). */
function MakePublic({ client, exclude, onChanged }: { client: DaisyClient; exclude: string[]; onChanged: () => void }) {
  const { s } = useDaisyTheme();
  const t = useT();
  const sessions = useLoad(() => client.sessions(), [client]);
  const [sid, setSid] = useState<string | null>(null);
  const options = useMemo(
    () =>
      ((sessions.value ?? []) as Session[])
        .filter((x) => !x.archived && !exclude.includes(x.id))
        .slice(0, 30)
        .map((x) => ({ value: x.id, label: x.title || x.id.slice(0, 8) })),
    [sessions.value, exclude],
  );
  return (
    <View style={{ gap: 8 }} testID="sharing-make-public">
      <Text style={s.label}>{t("ui-sharing.makePublic.pick")}</Text>
      <ErrorBox text={sessions.error} />
      <Choice testID="sharing-make-public-session" value={sid} onChange={setSid} options={options} />
      {sid ? (
        <View style={{ gap: 6 }}>
          <PublicAgentSection key={sid} client={client} sessionId={sid} />
          <Button variant="ghost" onPress={onChanged}>
            {t("ui-sharing.refreshList")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const lines = (t: string) =>
  t
    .split(/[\n,，]/)
    .map((x) => x.trim())
    .filter(Boolean);

function ResidentCreate({ client, catalog, onCreated }: { client: DaisyClient; catalog: Catalog; onCreated: (id: string) => void }) {
  const { s } = useDaisyTheme();
  const t = useT();
  const pc = usePinCall();
  const a = useAction();
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [harness, setHarness] = useState<string | null>(null),
    [workspaceId, setWorkspaceId] = useState<string | null>(null),
    [profileId, setProfileId] = useState<string | null>(null),
    [role, setRole] = useState("");
  const harnesses = [...new Set(catalog.profiles.map((p) => p.agent))];
  const ws = catalog.workspaces.find((w) => w.id === workspaceId);
  const profiles = catalog.profiles.filter((p) => p.agent === harness && (!ws || p.nodeId === ws.nodeId));
  return (
    <View style={{ gap: 8 }} testID="sharing-resident-create">
      <Field label={t("ui-sharing.resident.nameCard")} value={name} onChange={setName} testID="resident-create-name" />
      <Field label={t("ui-sharing.resident.descriptionNew")} value={description} onChange={setDescription} />
      <Text style={s.label}>harness</Text>
      <Choice value={harness} onChange={(h) => (setHarness(h), setProfileId(null))} options={harnesses.map((h) => ({ value: h, label: h }))} />
      <Text style={s.label}>{t("ui-sharing.resident.workspace")}</Text>
      <Choice value={workspaceId} onChange={(w) => (setWorkspaceId(w), setProfileId(null))} options={catalog.workspaces.map((w) => ({ value: w.id, label: shownName("workspace", w, t) }))} />
      <Text style={s.label}>{t("ui-sharing.resident.profile")}</Text>
      <Choice value={profileId} onChange={setProfileId} options={profiles.map((p) => ({ value: p.id, label: shownName("profile", p, t) }))} />
      <Field label={t("ui-sharing.resident.role")} value={role} onChange={setRole} multiline />
      <Text style={[s.muted, { fontSize: 11 }]}>{t("ui-sharing.resident.defaults")}</Text>
      <View style={[s.row, { justifyContent: "flex-end" }]}>
        <Button
          testID="resident-create-submit"
          disabled={!name.trim() || !harness || !workspaceId || !profileId}
          busy={a.busy === "create"}
          onPress={() =>
            void a.run("create", async () => {
              const r = await pc(t("ui-sharing.resident.createPinWhy"), (g) =>
                client.call(
                  api.residents.residentCreate,
                  {
                    body: {
                      name: name.trim(),
                      harness: harness!,
                      workspaceId: workspaceId!,
                      profileId: profileId!,
                      ...(description.trim() ? { description: description.trim() } : {}),
                      ...(role.trim() ? { role: role.trim() } : {}),
                    },
                  },
                  { pinGrant: g },
                ),
              );
              onCreated(r.id);
            })
          }
        >
          {t("ui-sharing.resident.create")}
        </Button>
      </View>
      <ErrorBox text={a.error} />
    </View>
  );
}

function ResidentEditor({ client, agentId, onChanged }: { client: DaisyClient; agentId: string; onChanged: () => void }) {
  const { C, s } = useDaisyTheme();
  const when = useDaisyTime();
  const t = useT();
  const pc = usePinCall();
  const a = useAction();
  const cur = useLoad(
    () => client.call(api.residents.residentShow, { params: { aid: agentId } }),
    [client, agentId],
  );
  const v = cur.value as (ResidentAgentView & { conversations: ResidentConversation[] }) | null;
  const [form, setForm] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<"" | "close" | "delete">("");
  if (!v) return <ErrorBox text={cur.error} />;
  const val = (k: string, d: string) => form[k] ?? d;
  const set = (k: string) => (x: string) => setForm({ ...form, [k]: x });
  const after = async (msg: string) => {
    setForm({});
    await cur.reload();
    onChanged();
    return msg;
  };
  const save = () =>
    void a.run("save", async () => {
      const body: Record<string, unknown> = {};
      for (const k of ["name", "description", "role", "instructions", "knowledge"] as const)
        if (form[k] !== undefined) body[k] = form[k];
      if (form.permissionMode !== undefined) body.permissionMode = form.permissionMode;
      if (form.approvals !== undefined) body.approvals = form.approvals;
      if (form.concurrency !== undefined) body.concurrency = Number(form.concurrency);
      if (form.dailyTurns !== undefined) body.dailyTurns = Number(form.dailyTurns);
      if (form.tools !== undefined) body.tools = form.tools.trim() ? lines(form.tools) : ["*"];
      if (form.dirs !== undefined) body.dirs = lines(form.dirs);
      await pc(t("ui-sharing.resident.savePinWhy"), (g) =>
        client.call(api.residents.residentSet, { params: { aid: agentId }, body: body as any }, { pinGrant: g }),
      );
      return after(t("ui-sharing.resident.saved"));
    });
  const toolsText = v.tools === null ? "" : v.tools.join(", ");
  const caveat = bashAllowed({ tools: form.tools !== undefined ? (form.tools.trim() ? lines(form.tools) : null) : v.tools, harness: v.harness });
  return (
    <View style={{ gap: 10 }} testID={`resident-${agentId}`}>
      <Text style={[s.muted, { fontSize: 12 }]}>
        {t("ui-sharing.resident.usage", { 
          harness: v.harness,
          active: v.usage.active,
          waiting: v.usage.waiting,
          turns: v.usage.turnsToday,
          path: v.a2aPath,
         })}
      </Text>
      {caveat ? (
        <View style={{ borderLeftWidth: 3, borderLeftColor: C.red, paddingLeft: 8 }} testID={`resident-${agentId}-caveat`}>
          <Text style={{ fontSize: 12, color: C.ink }}>{isolationCaveat()}</Text>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {v.state === "running" ? (
          <Button
            variant="outline"
            testID={`resident-${agentId}-pause`}
            busy={a.busy === "pause"}
            onPress={() =>
              void a.run("pause", async () => {
                const r = await client.call(api.residents.residentPause, { params: { aid: agentId } });
                return after(r.refused ? t("ui-sharing.resident.pausedRefused", { count: r.refused }) : t("ui-sharing.resident.paused"));
              })
            }
          >
            {t("ui-sharing.resident.pause")}
          </Button>
        ) : null}
        {v.state === "paused" ? (
          <Button
            variant="soft"
            testID={`resident-${agentId}-resume`}
            busy={a.busy === "resume"}
            onPress={() =>
              void a.run("resume", async () => {
                await pc(t("ui-sharing.resident.resumePinWhy"), (g) =>
                  client.call(api.residents.residentResume, { params: { aid: agentId } }, { pinGrant: g }),
                );
                return after(t("ui-sharing.resident.resumed"));
              })
            }
          >
            {t("ui-sharing.resident.resume")}
          </Button>
        ) : null}
        {v.state !== "closed" ? (
          <Button variant="outline" testID={`resident-${agentId}-close`} onPress={() => setConfirm("close")}>
            {t("ui-sharing.resident.close")}
          </Button>
        ) : null}
        <Button variant="danger" testID={`resident-${agentId}-delete`} onPress={() => setConfirm("delete")}>
          {t("ui-sharing.resident.delete")}
        </Button>
      </View>
      {confirm ? (
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 12, color: C.red }}>
            {confirm === "close"
              ? t("ui-sharing.resident.closeConfirm")
              : t("ui-sharing.resident.deleteConfirm")}
          </Text>
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            <Button variant="ghost" onPress={() => setConfirm("")}>
              {t("ui-sharing.cancel")}
            </Button>
            <Button
              variant="danger"
              testID={`resident-${agentId}-confirm`}
              busy={a.busy === confirm}
              onPress={() =>
                void a.run(confirm, async () => {
                  if (confirm === "close") {
                    const r = await client.call(api.residents.residentClose, { params: { aid: agentId } });
                    setConfirm("");
                    return after(r.stopped ? t("ui-sharing.resident.closedStopped", { count: r.stopped }) : t("ui-sharing.resident.closed"));
                  }
                  await client.call(api.residents.residentDelete, { params: { aid: agentId } });
                  setConfirm("");
                  onChanged();
                })
              }
            >
              {confirm === "close" ? t("ui-sharing.resident.confirmClose") : t("ui-sharing.resident.confirmDelete")}
            </Button>
          </View>
        </View>
      ) : null}
      {v.state !== "closed" ? (
        <View style={{ gap: 8 }}>
          <Field label={t("ui-sharing.resident.name")} value={val("name", v.name)} onChange={set("name")} />
          <Field label={t("ui-sharing.resident.description")} value={val("description", v.description)} onChange={set("description")} />
          <Text style={s.label}>{t("ui-sharing.resident.layers")}</Text>
          {v.layers.map((l) =>
            l.editable ? (
              <Field
                key={l.id}
                testID={`resident-${agentId}-layer-${l.id}`}
                label={l.title}
                value={val(l.id, v.prompt[l.id as "role"] ?? "")}
                onChange={set(l.id)}
                multiline
              />
            ) : (
              <View key={l.id} style={{ gap: 4 }}>
                <Text style={s.label}>{l.title}</Text>
                <Text selectable style={[s.muted, { fontSize: 11 }]} numberOfLines={6}>
                  {l.text}
                </Text>
              </View>
            ),
          )}
          <Text style={s.label}>{t("ui-sharing.resident.permissionMode")}</Text>
          <Choice
            value={val("permissionMode", v.permissionMode ?? "session")}
            onChange={set("permissionMode")}
            options={[{ value: "session", label: t("ui-sharing.resident.followProfile") }, ...v.modes.map((m) => ({ value: m, label: m }))]}
          />
          <Text style={s.label}>{t("ui-sharing.resident.approvals")}</Text>
          <Choice
            value={val("approvals", v.approvals)}
            onChange={set("approvals")}
            options={RESIDENT_APPROVALS.map((x) => ({
              value: x,
              label: x === "reject" ? t("ui-sharing.resident.approvalsReject") : t("ui-sharing.resident.approvalsAsk"),
            }))}
          />
          <Field label={t("ui-sharing.resident.concurrency")} value={val("concurrency", String(v.concurrency))} onChange={set("concurrency")} />
          <Field label={t("ui-sharing.resident.dailyTurns")} value={val("dailyTurns", String(v.dailyTurns))} onChange={set("dailyTurns")} />
          <Field
            label={t("ui-sharing.resident.tools")}
            value={val("tools", toolsText)}
            onChange={set("tools")}
            testID={`resident-${agentId}-tools`}
          />
          <Field label={t("ui-sharing.resident.dirs")} value={val("dirs", v.dirs.join("\n"))} onChange={set("dirs")} multiline />
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            <Button testID={`resident-${agentId}-save`} disabled={!Object.keys(form).length} busy={a.busy === "save"} onPress={save}>
              {t("ui-sharing.save")}
            </Button>
          </View>
        </View>
      ) : null}
      <ErrorBox text={a.error} />
      <Notice text={a.notice} />
      {v.conversations.length ? (
        <View style={{ gap: 4 }}>
          <Text style={s.label}>{t("ui-sharing.resident.conversations")}</Text>
          {v.conversations.slice(0, 20).map((c) => (
            <Text key={c.contextId} style={[s.muted, { fontSize: 11 }]}>
              {t("ui-sharing.resident.conversation", { 
                caller: c.caller,
                at: `${when.date(c.lastAt)} ${when.time(c.lastAt)}`,
                session: c.sessionId.slice(0, 8),
               })}
              {c.closedAt ? t("ui-sharing.resident.conversationEnded") : ""}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ── 永久授权 ───────────────────────────────────────────────────────────────

function GrantsSection({ client, rev, onChanged }: { client: DaisyClient; rev: number; onChanged: () => void }) {
  const { C, s } = useDaisyTheme();
  const when = useDaisyTime();
  const pc = usePinCall();
  const a = useAction();
  const t = useT();
  const list = useLoad(
    () => client.call(api.invoke.grantList, {}).then((r) => r.grants),
    [client, rev],
  );
  return (
    <Section
      title={t("ui-sharing.grants.title")}
      hint={t("ui-sharing.grants.hint")}
      testID="sharing-grants"
    >
      <ErrorBox text={list.error} />
      {list.value && !list.value.length ? (
        <Text style={{ fontSize: 13 }} testID="sharing-grants-empty">
          {t("ui-sharing.grants.empty")}
        </Text>
      ) : null}
      {(list.value ?? []).map((g: InvokeGrant) => (
        <Row key={g.id} testID={`grant-${g.id}`}>
          <Text style={{ color: C.ink, fontWeight: "600" }}>
            {g.person.name} → {g.agent.name}
          </Text>
          <Text style={[s.muted, { fontSize: 11 }]}>
            {g.person.issuer ? t("ui-sharing.grants.issuer", { issuer: g.person.issuer }) : ""}
            {t("ui-sharing.grants.approved", { date: when.date(g.grantedAt) })}
          </Text>
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            <Button
              variant="danger"
              testID={`grant-${g.id}-revoke`}
              busy={a.busy === g.id}
              onPress={() =>
                void a.run(g.id, async () => {
                  const r = await pc(t("ui-sharing.grants.revokePinWhy"), (gr) => client.call(api.invoke.grantRevoke, { params: { gid: g.id } }, { pinGrant: gr }));
                  await list.reload();
                  onChanged();
                  return r.stopped ? t("ui-sharing.grants.revokedStopped", { count: r.stopped }) : t("ui-sharing.grants.revoked");
                })
              }
            >
              {t("ui-sharing.grants.revoke")}
            </Button>
          </View>
        </Row>
      ))}
      <ErrorBox text={a.error} />
      <Notice text={a.notice} />
    </Section>
  );
}

// ── 互认的名片与白名单 ──────────────────────────────────────────────────────

function ContactsSection({ client, rev, onChanged }: { client: DaisyClient; rev: number; onChanged: () => void }) {
  const { C, s } = useDaisyTheme();
  const pc = usePinCall();
  const a = useAction();
  const t = useT();
  const list = useLoad(
    () => client.call(api.contacts.contactList, {}).then((r) => r.contacts),
    [client, rev],
  );
  const [mine, setMine] = useState<IdentityCardView | null>(null),
    [myName, setMyName] = useState(""),
    [text, setText] = useState(""),
    [seen, setSeen] = useState<CardInspection | null>(null),
    [checked, setChecked] = useState(false),
    [whitelist, setWhitelist] = useState(false),
    [exists, setExists] = useState(false),
    [removing, setRemoving] = useState<string | null>(null);
  const reset = () => {
    setText("");
    setSeen(null);
    setChecked(false);
    setWhitelist(false);
    setExists(false);
  };
  return (
    <Section
      title={t("ui-sharing.contacts.title")}
      hint={t("ui-sharing.contacts.hint")}
      testID="sharing-contacts"
    >
      {/* My card */}
      <View style={{ gap: 6 }}>
        <Text style={s.label}>{t("ui-sharing.contacts.mine")}</Text>
        <View style={[s.row, { flexWrap: "wrap", alignItems: "flex-end" }]}>
          <View style={{ flex: 1, minWidth: 180 }}>
            <Field label={t("ui-sharing.contacts.myName")} value={myName} onChange={setMyName} testID="contact-export-name" />
          </View>
          <Button
            variant="soft"
            testID="contact-export"
            busy={a.busy === "export"}
            onPress={() =>
              void a.run("export", async () => {
                setMine(
                  await client.call(api.contacts.contactExport, { query: myName.trim() ? { name: myName.trim() } : {} }),
                );
              })
            }
          >
            {t("ui-sharing.contacts.export")}
          </Button>
        </View>
        {mine ? (
          <View style={{ gap: 4 }} testID="contact-export-card">
            <Text selectable style={{ fontFamily: "monospace", fontSize: 11, color: C.ink }} testID="contact-export-text">
              {mine.text}
            </Text>
            <Text style={[s.muted, { fontSize: 11 }]}>{mine.verify}</Text>
            <View style={[s.row, { justifyContent: "flex-end" }]}>
              <Button variant="ghost" onPress={() => void copyText(mine.text).catch(() => {})}>
                {t("ui-sharing.copy")}
              </Button>
            </View>
          </View>
        ) : null}
      </View>
      {/* Import: look first, compare the number, then add */}
      <View style={{ gap: 6 }}>
        <Text style={s.label}>{t("ui-sharing.contacts.add")}</Text>
        <Field
          label={t("ui-sharing.contacts.cardText")}
          value={text}
          onChange={(x) => {
            setText(x);
            setSeen(null);
            setChecked(false);
            setExists(false);
          }}
          multiline
          testID="contact-import-text"
        />
        {!seen ? (
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            <Button
              variant="soft"
              testID="contact-inspect"
              disabled={!text.trim()}
              busy={a.busy === "inspect"}
              onPress={() =>
                void a.run("inspect", async () => {
                  setSeen(
                    // D-40 ①: looking comes before the PIN — the PIN is asked when adding.
                    await client.call(api.contacts.contactInspect, { body: { card: text.trim() } }),
                  );
                })
              }
            >
              {t("ui-sharing.contacts.inspect")}
            </Button>
          </View>
        ) : (
          <View style={{ gap: 6, padding: 10, borderRadius: 10, backgroundColor: C.soft }} testID="contact-inspection">
            <Text style={{ fontWeight: "600", color: C.ink }} testID="contact-inspection-name">
              {seen.card.name}
              {seen.card.note ? t("ui-sharing.contacts.note", { note: seen.card.note }) : ""}
            </Text>
            <Text style={s.label}>{t("ui-sharing.contacts.number")}</Text>
            <IdNumber id={seen.card.id} testID="contact-inspection-id" />
            <Text style={{ fontSize: 12, color: C.ink }}>{seen.card.verify}</Text>
            {seen.self ? (
              <ErrorBox text={t("ui-sharing.contacts.self")} />
            ) : (
              <>
                <Check
                  testID="contact-import-checked"
                  on={checked}
                  label={t("ui-sharing.contacts.checked")}
                  onChange={setChecked}
                />
                <Check
                  testID="contact-import-whitelist"
                  on={whitelist}
                  label={t("ui-sharing.contacts.alsoWhitelist")}
                  onChange={setWhitelist}
                />
                {exists ? (
                  <Text style={{ fontSize: 12, color: C.red }}>{t("ui-sharing.contacts.exists")}</Text>
                ) : null}
                <View style={[s.row, { justifyContent: "flex-end", flexWrap: "wrap" }]}>
                  <Button variant="ghost" onPress={reset}>
                    {t("ui-sharing.cancel")}
                  </Button>
                  <Button
                    testID="contact-import"
                    disabled={!checked}
                    busy={a.busy === "import"}
                    onPress={() =>
                      void a.run("import", async () => {
                        try {
                          const r = await pc(t("ui-sharing.contacts.importPinWhy"), (g) =>
                            client.call(
                              api.contacts.contactImport,
                              { body: { card: text.trim(), expectId: seen.card.id, ...(whitelist ? { whitelist: true } : {}), ...(exists ? { update: true } : {}) } },
                              { pinGrant: g },
                            ),
                          );
                          reset();
                          await list.reload();
                          onChanged();
                          return r.result === "added"
                            ? t("ui-sharing.contacts.added", { name: r.contact.name })
                            : r.result === "updated"
                              ? t("ui-sharing.contacts.updated", { name: r.contact.name })
                              : t("ui-sharing.contacts.unchanged");
                        } catch (e: any) {
                          if (e?.code === "contact_exists") setExists(true);
                          throw e;
                        }
                      })
                    }
                  >
                    {exists ? t("ui-sharing.contacts.replace") : t("ui-sharing.contacts.import")}
                  </Button>
                </View>
              </>
            )}
          </View>
        )}
      </View>
      <ErrorBox text={a.error || list.error} />
      <Notice text={a.notice} />
      {/* The list */}
      {list.value && !list.value.length ? (
        <Text style={{ fontSize: 13 }} testID="sharing-contacts-empty">
          {t("ui-sharing.contacts.empty")}
        </Text>
      ) : null}
      {(list.value ?? []).map((c: Contact) => (
        <Row key={c.id} testID={`contact-${c.id.slice(0, 8)}`}>
          <View style={[s.row, { flexWrap: "wrap" }]}>
            <Text style={{ flex: 1, minWidth: 120, fontWeight: "600", color: C.ink }}>
              {c.name}
              {c.note ? t("ui-sharing.contacts.note", { note: c.note }) : ""}
            </Text>
            {c.whitelisted ? <Badge text={t("ui-sharing.contacts.whitelisted")} color={C.green} /> : null}
          </View>
          <IdNumber id={c.id} />
          {c.addrs.length ? (
            <Text style={[s.muted, { fontSize: 11 }]}>
              {c.addrs
                .map((x) => (x.kind === "relay" ? t("ui-sharing.contacts.addrRelay", { url: x.url }) : t("ui-sharing.contacts.addrDirect", { url: x.url })))
                .join(" · ")}
            </Text>
          ) : (
            <Text style={[s.muted, { fontSize: 11 }]}>{t("ui-sharing.contacts.noAddr")}</Text>
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
            <Button
              variant="outline"
              testID={`contact-${c.id.slice(0, 8)}-whitelist`}
              busy={a.busy === `wl-${c.id}`}
              onPress={() =>
                void a.run(`wl-${c.id}`, async () => {
                  const def = c.whitelisted ? api.contacts.contactWhitelistRemove : api.contacts.contactWhitelistAdd;
                  await pc(t("ui-sharing.contacts.whitelistPinWhy"), (g) => client.call(def, { params: { id: c.id } }, { pinGrant: g }));
                  await list.reload();
                  onChanged();
                  return c.whitelisted
                    ? t("ui-sharing.contacts.whitelistRemoved", { name: c.name })
                    : t("ui-sharing.contacts.whitelistAdded", { name: c.name });
                })
              }
            >
              {c.whitelisted ? t("ui-sharing.contacts.whitelistRemove") : t("ui-sharing.contacts.whitelistAdd")}
            </Button>
            {removing === c.id ? (
              <Button
                variant="danger"
                testID={`contact-${c.id.slice(0, 8)}-remove-confirm`}
                busy={a.busy === `rm-${c.id}`}
                onPress={() =>
                  void a.run(`rm-${c.id}`, async () => {
                    await pc(t("ui-sharing.contacts.removePinWhy"), (g) => client.call(api.contacts.contactRemove, { params: { id: c.id } }, { pinGrant: g }));
                    setRemoving(null);
                    await list.reload();
                    onChanged();
                    return t("ui-sharing.contacts.removed", { name: c.name });
                  })
                }
              >
                {t("ui-sharing.contacts.confirmRemove")}
              </Button>
            ) : (
              <Button variant="danger" testID={`contact-${c.id.slice(0, 8)}-remove`} onPress={() => setRemoving(c.id)}>
                {t("ui-sharing.contacts.remove")}
              </Button>
            )}
          </View>
        </Row>
      ))}
    </Section>
  );
}

// ── 给第三方客户端的令牌 ─────────────────────────────────────────────────────

function TokensSection({ client, rev, onChanged }: { client: DaisyClient; rev: number; onChanged: () => void }) {
  const { C, s } = useDaisyTheme();
  const when = useDaisyTime();
  const pc = usePinCall();
  const a = useAction();
  const t = useT();
  const [all, setAll] = useState(false);
  const list = useLoad(
    () =>
      client.call(api.tokens.tokenList, { query: { state: all ? "all" : "active" } }).then((r) => r.tokens),
    [client, rev, all],
  );
  const contacts = useLoad(
    () => client.call(api.contacts.contactList, {}).then((r) => r.contacts),
    [client, rev],
  );
  const [forWho, setFor] = useState<string>("me"),
    [ttl, setTtl] = useState("7d"),
    [note, setNote] = useState(""),
    [issued, setIssued] = useState<{ token: string; warning: string; record: VisitorToken } | null>(null);
  return (
    <Section
      title={t("ui-sharing.tokens.title")}
      hint={t("ui-sharing.tokens.hint")}
      testID="sharing-tokens"
      right={
        <Button variant="ghost" onPress={() => setAll(!all)}>
          {all ? t("ui-sharing.tokens.showActive") : t("ui-sharing.tokens.showAll")}
        </Button>
      }
    >
      <Text style={s.label}>{t("ui-sharing.tokens.for")}</Text>
      <Choice
        testID="token-for"
        value={forWho}
        onChange={setFor}
        options={[{ value: "me", label: t("ui-sharing.tokens.me") }, ...(contacts.value ?? []).map((c) => ({ value: c.id, label: c.name }))]}
      />
      <Text style={s.label}>{t("ui-sharing.tokens.ttl")}</Text>
      <Choice testID="token-ttl" value={ttl} onChange={setTtl} options={tokenTtls()} />
      <Field label={t("ui-sharing.tokens.note")} value={note} onChange={setNote} testID="token-note" />
      <View style={[s.row, { justifyContent: "flex-end" }]}>
        <Button
          testID="token-issue"
          busy={a.busy === "issue"}
          onPress={() =>
            void a.run("issue", async () => {
              const r = await pc(t("ui-sharing.tokens.issuePinWhy"), (g) =>
                client.call(api.tokens.tokenIssue, { body: { for: forWho, ttl, ...(note.trim() ? { note: note.trim() } : {}) } }, { pinGrant: g }),
              );
              setIssued(r);
              setNote("");
              await list.reload();
              onChanged();
            })
          }
        >
          {t("ui-sharing.tokens.issue")}
        </Button>
      </View>
      {issued ? (
        <View style={{ gap: 6, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: C.red }} testID="token-issued">
          <Text style={{ fontSize: 12, color: C.red, fontWeight: "600" }}>{issued.warning}</Text>
          <Text selectable style={{ fontFamily: "monospace", fontSize: 11, color: C.ink }} testID="token-issued-text">
            {issued.token}
          </Text>
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            <Button variant="ghost" onPress={() => void copyText(issued.token).catch(() => {})}>
              {t("ui-sharing.copy")}
            </Button>
            <Button variant="soft" testID="token-issued-done" onPress={() => setIssued(null)}>
              {t("ui-sharing.tokens.saved")}
            </Button>
          </View>
        </View>
      ) : null}
      <ErrorBox text={a.error || list.error} />
      <Notice text={a.notice} />
      {list.value && !list.value.length ? (
        <Text style={{ fontSize: 13 }}>{all ? t("ui-sharing.tokens.noneIssued") : t("ui-sharing.tokens.noneActive")}</Text>
      ) : null}
      {(list.value ?? []).map((tk: VisitorToken) => (
        <Row key={tk.jti} testID={`token-${tk.jti}`}>
          <View style={[s.row, { flexWrap: "wrap" }]}>
            <Text style={{ flex: 1, minWidth: 120, color: C.ink, fontWeight: "600" }}>
              {tokenForLabel(tk)}
              {tk.note ? ` · ${tk.note}` : ""}
            </Text>
            <Badge text={tokenStateLabel(tk)} color={tk.state === "active" ? C.green : C.muted} />
          </View>
          <Text style={[s.muted, { fontSize: 11 }]}>
            {t("ui-sharing.tokens.line", { 
              jti: tk.jti,
              expires: when.date(tk.expiresAt),
              used: tk.lastUsedAt
                ? t("ui-sharing.tokens.lastUsed", { at: `${when.date(tk.lastUsedAt)} ${when.time(tk.lastUsedAt)}` })
                : t("ui-sharing.tokens.neverUsed"),
             })}
          </Text>
          {tk.state === "active" ? (
            <View style={[s.row, { justifyContent: "flex-end" }]}>
              <Button
                variant="danger"
                testID={`token-${tk.jti}-revoke`}
                busy={a.busy === tk.jti}
                onPress={() =>
                  void a.run(tk.jti, async () => {
                    await pc(t("ui-sharing.tokens.revokePinWhy"), (g) =>
                      client.call(api.tokens.tokenRevoke, { params: { jti: tk.jti } }, { pinGrant: g }),
                    );
                    await list.reload();
                    return t("ui-sharing.tokens.revoked");
                  })
                }
              >
                {t("ui-sharing.tokens.revoke")}
              </Button>
            </View>
          ) : null}
        </Row>
      ))}
    </Section>
  );
}

// ── 我的 AI 调用了谁 ─────────────────────────────────────────────────────────

function OutgoingCallsSection({ client }: { client: DaisyClient }) {
  const { C, s } = useDaisyTheme();
  const when = useDaisyTime();
  const t = useT();
  const list = useLoad(() => client.call(api.outgoing.outgoingList, { query: { limit: 50 } }).then((r) => r.calls), [client]);
  const [openId, setOpenId] = useState<string | null>(null),
    [full, setFull] = useState<OutgoingCall | null>(null);
  return (
    <Section
      title={t("ui-sharing.outgoing.title")}
      hint={t("ui-sharing.outgoing.hint")}
      testID="sharing-outgoing"
      right={
        <Button variant="ghost" onPress={() => void list.reload()}>
          {t("ui-sharing.refresh")}
        </Button>
      }
    >
      <ErrorBox text={list.error} />
      {list.value && !list.value.length ? (
        <Text style={{ fontSize: 13 }} testID="sharing-outgoing-empty">
          {t("ui-sharing.outgoing.empty")}
        </Text>
      ) : null}
      {(list.value ?? []).map((c) => {
        const open = openId === c.id;
        const shown = open && full?.id === c.id ? full : c;
        return (
          <Row key={c.id} testID={`outgoing-${c.id}`}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setOpenId(open ? null : c.id);
                if (!open)
                  void client
                    .call(api.outgoing.outgoingShow, { params: { cid: c.id } })
                    .then(setFull)
                    .catch(() => {});
              }}
            >
              <View style={[s.row, { flexWrap: "wrap" }]}>
                <Text style={{ flex: 1, minWidth: 160, color: C.ink, fontWeight: "600" }}>
                  {t("ui-sharing.outgoing.heading", { session: c.session.title, contact: c.contact.name, agent: c.agent.name })}
                </Text>
                <Badge
                  text={t("ui-sharing.outgoing.badge", { mode: c.mode === "act" ? t("ui-sharing.outgoing.act") : t("ui-sharing.outgoing.ask"), state: c.stateLabel })} color={c.state === "TASK_STATE_COMPLETED" ? C.green : c.state === "error" || c.state === "TASK_STATE_FAILED" || c.state === "TASK_STATE_REJECTED" ? C.red : C.accent} />
              </View>
              <Text style={[s.muted, { fontSize: 11 }]}>
                {t("ui-sharing.outgoing.meta", { 
                  at: `${when.date(c.created)} ${when.time(c.created)}`,
                  trace: c.traceId.slice(0, 8),
                  depth: c.depth,
                 })}
              </Text>
              <Text style={{ fontSize: 12, color: C.ink }} numberOfLines={open ? undefined : 2}>
                {c.text}
              </Text>
            </Pressable>
            {open ? (
              <View style={{ gap: 4 }}>
                {shown.statusText ? (
                  <Text style={[s.muted, { fontSize: 12 }]}>{t("ui-sharing.outgoing.status", { status: shown.statusText })}</Text>
                ) : null}
                {shown.answer ? (
                  <Text selectable style={{ fontSize: 12, color: C.ink }}>
                    {t("ui-sharing.outgoing.answer", { answer: shown.answer })}
                  </Text>
                ) : null}
                {shown.files.length ? (
                  <Text style={[s.muted, { fontSize: 11 }]}>
                    {t("ui-sharing.outgoing.files", { files: shown.files.join(t("ui-sharing.sep")) })}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </Row>
        );
      })}
    </Section>
  );
}
