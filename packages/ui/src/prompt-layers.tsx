import React, { useCallback, useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import type { DaisyClient } from "@daisy-ai/client";
import type {
  GuideLayer,
  GuideLayerName,
  MyPromptView,
  PromptLayerAdminView,
  PromptOptional,
  Session,
  SessionPromptView,
  User,
} from "@daisy-ai/contracts";
import { GUIDE_LIMITS, type Translate } from "@daisy-ai/contracts";
import { Dialog } from "./index";
import { Button, ErrorBox, Text } from "./primitives";
import { useDaisyTheme } from "./theme";
import { useDaisyTime } from "./host";
import { useT } from "./i18n";
import { INJECT_MARK, shownName } from "@daisy-ai/contracts";
/**
 * Daisy's layered prompt, for the person —
 *
 * - `MyPromptPanel` (设置 › AI 提示词): what every session of mine gets and
 *   cannot be changed here (the organisation's boot core, the safety rules), my
 *   own note for all my ordinary sessions, four optional sections on / off;
 *   for admins also the switch and 「立即生效」.
 * - `SessionPromptSection` (会话设置 › 提示词): this session's own note and
 *   switches (each follows my default until set here), and the way into…
 * - `SessionPromptDialog`: what this session really gets — layer by layer,
 *   each section with where it comes from and who may change it; what
 *   every turn adds; what the Runner last launched it with.
 *
 * State is always said in words (锁定 / 跟随默认 / 已改写 / 已关闭 / 由设置生成
 * / 自定义), never by colour alone.
 */
const LAYER_ORDER: GuideLayerName[] = ["org", "session", "owner", "safety"];
/** Where the org core came from, in words (levels 1–4). */
const levelText = (level: number, t: Translate) =>
  level >= 1 && level <= 4 ? t.dynamic(`ui-prompts.level.${level}`) : "";
/** A fixed-key state text, or the raw value when the key set has none. */
const known = (t: Translate, key: string, raw: string) => (t.has(key) ? t.dynamic(key) : raw);
function useNoteBox() {
  const { C } = useDaisyTheme();
  return {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 8,
    padding: 8,
    minHeight: 84,
    color: C.ink,
    fontSize: 13,
    textAlignVertical: "top" as const,
  };
}
function Count({ n, max }: { n: number; max: number }) {
  const { C } = useDaisyTheme();
  const t = useT();
  return (
    <Text style={{ fontSize: 11, color: n > max ? C.red : C.muted }}>
      {t(n > max ? "ui-prompts.countOver" : "ui-prompts.count", { n, max })}
    </Text>
  );
}
function History({
  rows,
  testID,
}: {
  rows: { at: number; by: string; summary: string }[];
  testID?: string;
}) {
  const { C, s } = useDaisyTheme();
  const when = useDaisyTime();
  const t = useT();
  if (!rows.length) return null;
  return (
    <View style={{ gap: 2 }} testID={testID}>
      <Text style={s.label}>{t("ui-prompts.history.title")}</Text>
      {rows.slice(0, 8).map((h, i) => (
        <Text key={i} style={{ fontSize: 12, color: C.ink }}>
          {t("ui-prompts.history.row", { time: when.time(h.at), by: h.by, summary: h.summary })}
        </Text>
      ))}
    </View>
  );
}
/** One optional section: its state in words and one button. */
function OptionalRow({
  title,
  state,
  action,
  onPress,
  busy,
  testID,
}: {
  title: string;
  state: string;
  action: string;
  onPress: () => void;
  busy?: boolean;
  testID: string;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  return (
    <View
      style={[s.row, { gap: 8, flexWrap: "wrap" }]}
      testID={testID}
      accessibilityLabel={t("ui-prompts.optional.a11y", { title, state })}
    >
      <View style={{ flex: 1, minWidth: 180 }}>
        <Text style={{ fontSize: 13, color: C.ink }}>{title}</Text>
        <Text style={{ fontSize: 11, color: C.muted }} testID={`${testID}-state`}>
          {state}
        </Text>
      </View>
      <Button variant="soft" busy={busy} onPress={onPress} testID={`${testID}-toggle`}>
        {action}
      </Button>
    </View>
  );
}
export function MyPromptPanel({
  client,
  user,
}: {
  client: DaisyClient;
  user: User | null;
}) {
  const { s } = useDaisyTheme();
  const t = useT();
  const box = useNoteBox();
  const [v, setV] = useState<MyPromptView | null>(null),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("");
  const take = (x: MyPromptView) => {
    setV(x);
    setNote(x.note);
  };
  useEffect(() => {
    // An older control plane has no such route: the section stays hidden.
    void client.myPrompt().then(take, () => {});
  }, [client]);
  const run = async (key: string, f: () => Promise<MyPromptView>, done: string) => {
    setBusy(key);
    setError("");
    setSaved("");
    try {
      take(await f());
      setSaved(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  if (!v) return null;
  const max = v.limits.noteMax;
  return (
    <View style={[s.card, { gap: 10 }]} testID="my-prompt">
      <Text style={s.h3}>{t("ui-prompts.my.title")}</Text>
      <Text style={[s.muted, { fontSize: 12 }]} testID="my-prompt-locked">
        {t("ui.prompts.my.locked")}
      </Text>
      <Text style={s.label}>{t("ui-prompts.my.noteLabel")}</Text>
      <TextInput
        testID="my-prompt-note"
        accessibilityLabel={t("ui-prompts.my.noteA11y")}
        multiline
        value={note}
        onChangeText={(x) => {
          setNote(x);
          setError("");
        }}
        placeholder={t("ui-prompts.my.notePlaceholder")}
        style={box}
      />
      <View style={[s.row, { gap: 8, justifyContent: "space-between", flexWrap: "wrap" }]}>
        <Count n={note.trim().length} max={max} />
        <Button
          testID="my-prompt-save"
          busy={busy === "note"}
          disabled={note.trim() === v.note || note.trim().length > max}
          onPress={() =>
            void run("note", () => client.saveMyPrompt({ note }), t("ui-prompts.saved"))
          }
        >
          {t("ui-prompts.my.saveNote")}
        </Button>
      </View>
      <Text style={s.label}>{t("ui-prompts.my.optionalLabel")}</Text>
      {v.optional.map((o) => {
        const on = v.sections[o.key];
        return (
          <OptionalRow
            key={o.key}
            testID={`my-prompt-${o.key}`}
            title={o.title}
            state={
              on === o.default
                ? t("ui-prompts.state.withDefault", { state: onOff(t, on) })
                : onOff(t, on)
            }
            action={t(on ? "ui-prompts.action.turnOff" : "ui-prompts.action.turnOn")}
            busy={busy === o.key}
            onPress={() =>
              void run(
                o.key,
                () => client.saveMyPrompt({ sections: { [o.key]: !on } }),
                t(on ? "ui-prompts.done.off" : "ui-prompts.done.on", { title: o.title }),
              )
            }
          />
        );
      })}
      <Text style={[s.muted, { fontSize: 12 }]}>{t("ui-prompts.my.effect")}</Text>
      {saved ? (
        <Text style={[s.muted, { fontSize: 12 }]} testID="my-prompt-saved">
          {saved}
        </Text>
      ) : null}
      {error ? <ErrorBox text={error} /> : null}
      <History rows={v.history} testID="my-prompt-history" />
      {/* P1-03: the owner is the only one — the switch is hers. */}
      {user ? <PromptLayerAdmin client={client} /> : null}
    </View>
  );
}
/** On / Off in words. */
const onOff = (t: Translate, on: boolean | undefined) => t(on ? "ui-prompts.state.on" : "ui-prompts.state.off");
/** Admins: the switch, 「立即生效」, and what each node's Runner read. */
function PromptLayerAdmin({ client }: { client: DaisyClient }) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const when = useDaisyTime();
  const [v, setV] = useState<PromptLayerAdminView | null>(null),
    [list, setList] = useState(""),
    [freshList, setFreshList] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false),
    // The expected hash as typed (never filled in from what a node reported).
    [expected, setExpected] = useState("");
  const take = (x: PromptLayerAdminView) => {
    setV(x);
    setList([...x.settings.sessions, ...x.settings.users].join("\n"));
    setFreshList(x.settings.freshList.join("\n"));
  };
  useEffect(() => {
    void client.promptLayerAdmin().then(take, () => {});
  }, [client]);
  const run = async (
    key: string,
    f: () => Promise<PromptLayerAdminView>,
    /** Keep the confirmation open (it shows what `f` returned). */
    asking = false,
  ) => {
    setBusy(key);
    setError("");
    try {
      take(await f());
      setConfirm(asking);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  if (!v) return null;
  const st = v.settings;
  /** What this save dropped or warns of (the server's words). */
  const notices = [
    ...(v.pruned
      ? [
          t("ui-prompts.admin.pruned", {
            items: [...v.pruned.sessions, ...v.pruned.users, ...v.pruned.freshList].join(t("ui-prompts.sep")),
          }),
        ]
      : []),
    ...(v.warnings || []),
  ];
  const flag = (
    key: "staticRules" | "claudeFresh" | "orgRead",
    title: string,
    on: string,
    off: string,
  ) => (
    <OptionalRow
      testID={`prompt-admin-${key}`}
      title={title}
      state={st[key] ? on : off}
      action={t(st[key] ? "ui-prompts.action.turnOff" : "ui-prompts.action.turnOn")}
      busy={busy === key}
      onPress={() =>
        void run(key, () => client.savePromptLayerAdmin({ [key]: !st[key] }))
      }
    />
  );
  return (
    <View style={{ gap: 8 }} testID="prompt-admin">
      <View style={{ height: 1, backgroundColor: C.line }} />
      <Text style={s.label}>{t("ui-prompts.admin.switch")}</Text>
      <Text style={[s.muted, { fontSize: 12 }]} testID="prompt-admin-mode">
        {t("ui-prompts.admin.modeNow", { mode: t.dynamic(`ui-prompts.mode.${st.mode}`) })}
      </Text>
      <View style={[s.row, { gap: 6, flexWrap: "wrap" }]}>
        {(["off", "allowlist", "all"] as const).map((m) => (
          <Button
            key={m}
            variant={st.mode === m ? "primary" : "outline"}
            busy={busy === m}
            testID={`prompt-admin-mode-${m}`}
            onPress={() => void run(m, () => client.savePromptLayerAdmin({ mode: m }))}
          >
            {t.dynamic(`ui-prompts.modeButton.${m}`)}
          </Button>
        ))}
      </View>
      {st.mode === "allowlist" ? (
        <View style={{ gap: 4 }}>
          <Text style={s.label}>{t("ui-prompts.admin.listLabel")}</Text>
          <TextInput
            testID="prompt-admin-list"
            accessibilityLabel={t("ui-prompts.admin.listA11y")}
            multiline
            value={list}
            onChangeText={setList}
            style={{
              borderWidth: 1,
              borderColor: C.line,
              borderRadius: 8,
              padding: 8,
              minHeight: 60,
              color: C.ink,
              fontSize: 12,
            }}
          />
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            <Button
              variant="soft"
              busy={busy === "list"}
              testID="prompt-admin-list-save"
              onPress={() => {
                const ids = list
                  .split(/\s+/)
                  .map((x) => x.trim())
                  .filter(Boolean);
                // The server tells sessions from members: try as sessions
                // first, the rest as members.
                void run("list", async () => {
                  const sessions: string[] = [],
                    people: string[] = [];
                  for (const x of ids) {
                    try {
                      await client.request(`/sessions/${x}`);
                      sessions.push(x);
                    } catch {
                      people.push(x);
                    }
                  }
                  return client.savePromptLayerAdmin({ sessions, users: people });
                });
              }}
            >
              {t("ui-prompts.admin.listSave")}
            </Button>
          </View>
        </View>
      ) : null}
      {flag(
        "staticRules",
        t("ui-prompts.admin.staticRules.title"),
        t("ui-prompts.admin.staticRules.on"),
        t("ui-prompts.admin.staticRules.off"),
      )}
      {flag(
        "claudeFresh",
        t("ui-prompts.admin.claudeFresh.title"),
        t("ui-prompts.admin.claudeFresh.on"),
        t("ui-prompts.admin.claudeFresh.off"),
      )}
      {st.claudeFresh ? (
        <View style={{ gap: 4 }}>
          <Text style={s.label}>{t("ui-prompts.admin.freshLabel")}</Text>
          <TextInput
            testID="prompt-admin-fresh-list"
            accessibilityLabel={t("ui-prompts.admin.freshA11y")}
            multiline
            value={freshList}
            onChangeText={setFreshList}
            style={{
              borderWidth: 1,
              borderColor: C.line,
              borderRadius: 8,
              padding: 8,
              minHeight: 44,
              color: C.ink,
              fontSize: 12,
            }}
          />
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            <Button
              variant="soft"
              busy={busy === "fresh"}
              testID="prompt-admin-fresh-list-save"
              onPress={() =>
                void run("fresh", () =>
                  client.savePromptLayerAdmin({
                    freshList: freshList
                      .split(/\s+/)
                      .map((x) => x.trim())
                      .filter(Boolean),
                  }),
                )
              }
            >
              {t("ui-prompts.admin.freshSave")}
            </Button>
          </View>
        </View>
      ) : null}
      {v.docId ? (
        <>
          {flag(
            "orgRead",
            t("ui-prompts.admin.orgRead.title"),
            st.mode === "off"
              ? t("ui-prompts.admin.orgRead.onWhileOff")
              : t("ui-prompts.admin.orgRead.on"),
            t("ui-prompts.admin.orgRead.off"),
          )}
          <Text style={s.label}>{t("ui-prompts.core.sourceLabel", { doc: v.docId })}</Text>
          <Text style={{ fontSize: 12, color: C.ink }} testID="prompt-admin-core">
            {coreText(t, v, when.time)}
          </Text>
          <Text style={s.label}>{t("ui-prompts.expected.label")}</Text>
          <Text style={{ fontSize: 12, color: C.muted }} testID="prompt-admin-expected-state">
            {v.expected
              ? t("ui-prompts.expected.now", {
                  sha: v.expected.sha256,
                  by: v.expected.by || t("ui-prompts.expected.owner"),
                  time: when.time(v.expected.at),
                  unseen: v.expected.seen ? "" : t("ui-prompts.expected.unseen"),
                })
              : t("ui-prompts.expected.notSet")}{" "}
            {t("ui-prompts.expected.explain", { hint: v.verifyHint ?? "" })}
          </Text>
          <TextInput
            testID="prompt-admin-expected"
            accessibilityLabel={t("ui-prompts.expected.a11y")}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("ui-prompts.expected.placeholder")}
            value={expected}
            onChangeText={setExpected}
            style={{
              borderWidth: 1,
              borderColor: C.line,
              borderRadius: 8,
              padding: 8,
              color: C.ink,
              fontSize: 12,
            }}
          />
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            <Button
              variant="soft"
              busy={busy === "expected"}
              testID="prompt-admin-expected-save"
              onPress={() =>
                void run("expected", async () => {
                  // `sha256sum` prints the hash, then the file name.
                  const x = await client.savePromptLayerAdmin({
                    orgExpected: expected.trim().split(/\s+/)[0].toLowerCase(),
                  });
                  setExpected("");
                  return x;
                })
              }
            >
              {t("ui-prompts.expected.save")}
            </Button>
          </View>
        </>
      ) : (
        <Text style={[s.muted, { fontSize: 12 }]} testID="prompt-admin-no-org">
          {t("ui.prompts.admin.noOrgCore")}
        </Text>
      )}
      {v.alerts.map((a, i) => (
        <Text
          key={i}
          style={{ fontSize: 12, color: C.red }}
          testID="prompt-admin-alert"
          accessibilityRole="alert"
        >
          {t("ui-prompts.admin.alert", { text: a })}
        </Text>
      ))}
      {notices.map((a, i) => (
        <Text key={`n${i}`} style={{ fontSize: 12, color: C.ink }} testID="prompt-admin-notice">
          {a}
        </Text>
      ))}
      {v.docId ? (
        <>
          <Text style={s.label}>{t("ui-prompts.node.title")}</Text>
          {v.nodes.map((n) => (
            <Text
              key={n.id}
              style={{ fontSize: 12, color: C.ink }}
              testID={`prompt-admin-node-${n.id}`}
            >
              {t("ui-prompts.node.line", { label: shownName("node", n, t), status: nodeStatus(t, n, when.time) })}
              {n.org ? (
                <Text
                  testID={`prompt-admin-node-forget-${n.id}`}
                  accessibilityRole="button"
                  onPress={() =>
                    void run(`forget:${n.id}`, () =>
                      client.forgetPromptLayerNode(n.id),
                    )
                  }
                  style={{ color: C.accent }}
                >
                  {"  "}
                  {t("ui-prompts.node.forget")}
                </Text>
              ) : null}
            </Text>
          ))}
        </>
      ) : null}
      {confirm ? (
        <View style={{ gap: 6 }} testID="prompt-admin-apply-confirm">
          <Text style={{ fontSize: 12, color: C.ink }} testID="prompt-admin-estimate">
            {v.estimate
              ? v.estimate.sessions
                ? t("ui-prompts.estimate.some", {
                    sessions: v.estimate.sessions,
                    owners: v.estimate.owners,
                    people: v.estimate.people
                      .map((p) => t("ui-prompts.estimate.person", { name: p.username, n: p.sessions }))
                      .join(t("ui-prompts.sep")),
                    immediate: v.estimate.immediate ?? 0,
                    truncated: v.estimate.truncated
                      ? t("ui-prompts.estimate.truncated", { limit: v.estimate.limit, n: v.estimate.truncated })
                      : "",
                  })
                : t("ui-prompts.estimate.none")
              : t("ui-prompts.estimate.loading")}
          </Text>
          <Text style={{ fontSize: 12, color: C.muted }}>{t("ui-prompts.estimate.explain")}</Text>
          <View style={[s.row, { gap: 6, justifyContent: "flex-end" }]}>
            <Button variant="soft" onPress={() => setConfirm(false)}>
              {t("ui-prompts.estimate.cancel")}
            </Button>
            {v.estimate?.sessions ? (
              <Button
                variant="danger"
                busy={busy === "apply"}
                testID="prompt-admin-apply-yes"
                onPress={() =>
                  void run("apply", () =>
                    client.applyPromptLayersNow({
                      confirm: true,
                      token: v.estimate?.token,
                    }),
                  )
                }
              >
                {t("ui-prompts.estimate.confirm")}
              </Button>
            ) : null}
          </View>
        </View>
      ) : (
        <View style={[s.row, { gap: 8, justifyContent: "space-between", flexWrap: "wrap" }]}>
          <Text style={{ fontSize: 11, color: C.muted }} testID="prompt-admin-epoch">
            {t("ui-prompts.apply.status", {
              epoch: st.epoch,
              waiting: v.apply.waiting,
              running: v.apply.running,
              done: v.apply.done,
              skipped: v.apply.skipped,
            })}
            {v.apply.batch ? t("ui-prompts.apply.batch", { n: v.apply.batch }) : ""}
            {v.cancelled !== undefined
              ? t("ui-prompts.apply.cancelled", {
                  n: v.cancelled,
                  still: v.stillRunning ? t("ui-prompts.apply.stillRunning", { n: v.stillRunning }) : "",
                })
              : ""}
          </Text>
          <View style={[s.row, { gap: 6 }]}>
            {v.apply.batchWaiting ? (
              <Button
                variant="outline"
                busy={busy === "cancel"}
                testID="prompt-admin-apply-cancel"
                onPress={() =>
                  void run("cancel", () => client.cancelPromptLayerApply())
                }
              >
                {t("ui-prompts.apply.cancelBatch", { n: v.apply.batchWaiting })}
              </Button>
            ) : null}
            {st.mode !== "off" && !v.apply.batch ? (
              <Button
                variant="outline"
                busy={busy === "estimate"}
                testID="prompt-admin-apply"
                onPress={() =>
                  // First only what it would do.
                  void run(
                    "estimate",
                    () => client.applyPromptLayersNow({ confirm: false }),
                    true,
                  )
                }
              >
                {t("ui-prompts.apply.now")}
              </Button>
            ) : null}
          </View>
        </View>
      )}
      {error ? <ErrorBox text={error} /> : null}
    </View>
  );
}
/** The org core's source in words (admin view). */
function coreText(t: Translate, v: PromptLayerAdminView, time: (at: number) => string): string {
  const core = v.core;
  const text =
    core.source === "control-plane"
      ? t(core.expired ? "ui-prompts.core.cpExpired" : "ui-prompts.core.cp", {
          version: core.version || "?",
          sha: core.sha256.slice(0, 8),
          time: time(core.fetchedAt),
          problem: core.problem ?? "",
        })
      : core.source === "runner"
        ? t("ui-prompts.core.runner", { sha: core.sha256.slice(0, 8), problem: core.problem ?? "" })
        : t("ui-prompts.core.none", {
            problem: core.problem ?? "",
            more: t(v.expected ? "ui-prompts.core.noneNoReport" : "ui-prompts.core.noneNoExpected"),
          });
  if (core.source === "none") return text;
  const note =
    core.source !== "control-plane" || core.expired
      ? t("ui-prompts.core.noAuthority", { max: v.pilotMax ?? 5 })
      : t(core.knowsInjection ? "ui-prompts.core.knowsMark" : "ui-prompts.core.oldMark", { mark: INJECT_MARK });
  return t("ui-prompts.core.withNote", { text, note });
}
/** One node's report in words (admin view). */
function nodeStatus(
  t: Translate,
  n: PromptLayerAdminView["nodes"][number],
  time: (at: number) => string,
): string {
  const why = (problem?: string) => (problem ? t("ui-prompts.paren", { text: problem }) : "");
  const parts = [
    n.org
      ? n.org.sha256
        ? // The first digits only: enough to see whether two are the
          // same, not something to copy into the field above.
          t("ui-prompts.node.hash", {
            sha: n.org.sha256,
            match: n.org.accepted
              ? t("ui-prompts.node.matches")
              : t("ui-prompts.node.mismatch", { why: why(n.org.problem) }),
          })
        : t("ui-prompts.node.notRead", { why: why(n.org.problem) })
      : t("ui-prompts.node.none"),
    n.org ? t("ui-prompts.node.lastReport", { time: time(n.org.reportedAt) }) : "",
    // What the node says of itself — numbers and one of a fixed list of
    // reasons (the control plane's words for its code).
    n.org
      ? t("ui-prompts.node.self", {
          items: [
            n.org.self.version ? `v${n.org.self.version}` : "",
            n.org.self.level === 4 ? t("ui-prompts.node.noTextThisTime") : levelText(n.org.self.level, t),
            n.org.self.reasonText || "",
          ]
            .filter(Boolean)
            .join(t("ui-prompts.node.selfSep")),
        })
      : "",
    n.promptLayers ? "" : t("ui-prompts.node.oldRunner"),
    n.release ? t("ui-prompts.node.release", { build: n.release.slice(0, 7) }) : "",
    n.active ? "" : t("ui-prompts.node.inactive"),
    n.org?.logDropped ? t("ui-prompts.node.dropped", { n: n.org.logDropped }) : "",
  ];
  return parts.filter(Boolean).join(t("ui-prompts.dot"));
}
/**
 * Whether the composed text is what the conversation holds (in words), and
 * 「立即压缩并生效」 where a compaction would bring it.
 */
export function ApplyNow({
  state,
  busy,
  onPress,
}: {
  state: {
    effectiveText?: string;
    apply?: { available: boolean; state?: string; note?: string };
  };
  busy?: boolean;
  onPress: () => void;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const a = state.apply;
  return (
    <View style={{ gap: 4 }} testID="prompt-apply">
      {state.effectiveText ? (
        <Text style={{ fontSize: 12, color: C.ink }} testID="prompt-apply-effective">
          {state.effectiveText}
        </Text>
      ) : null}
      {a?.state && a.state !== "done" ? (
        <Text style={{ fontSize: 12, color: C.muted }} testID="prompt-apply-state">
          {known(t, `ui-prompts.applyState.${a.state}`, a.state)}
          {a.note ? t("ui-prompts.paren", { text: a.note }) : ""}
        </Text>
      ) : null}
      {a?.available ? (
        <View style={[s.row, { gap: 8, justifyContent: "space-between", flexWrap: "wrap" }]}>
          <Text style={{ fontSize: 11, color: C.muted, flex: 1, minWidth: 180 }}>
            {t("ui-prompts.applyNow.explain")}
          </Text>
          <Button variant="outline" busy={busy} onPress={onPress} testID="prompt-apply-now">
            {t("ui-prompts.applyNow.button")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
/** 会话设置 › 提示词 (ordinary sessions; a resident has its own page). */
export function SessionPromptSection({
  client,
  sessionId,
  session,
}: {
  client: DaisyClient;
  sessionId: string;
  session?: Session;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const box = useNoteBox();
  const [v, setV] = useState<SessionPromptView | null>(null),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(""),
    [open, setOpen] = useState(false);
  const take = (x: SessionPromptView) => {
    setV(x);
    setNote(x.extra?.note || "");
  };
  useEffect(() => {
    // Not its owner, or an older control plane: no section.
    void client.sessionPrompt(sessionId).then(take, () => {});
  }, [client, sessionId]);
  const run = async (
    key: string,
    f: () => Promise<SessionPromptView>,
    done: string,
  ) => {
    setBusy(key);
    setError("");
    setSaved("");
    try {
      take(await f());
      setSaved(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  if (!v || session?.kind === "resident" || v.kind !== "ordinary") return null;
  const max = v.limits.noteMax,
    own = v.extra?.note || "";
  return (
    <View style={{ gap: 8 }} testID="session-prompt">
      <Text style={s.label}>{t("ui-prompts.session.title")}</Text>
      <Text style={[s.muted, { fontSize: 12 }]}>
        {t("ui-prompts.session.intro", {
          now: v.layered.on ? "" : t("ui-prompts.session.now", { why: v.layered.why ?? "" }),
        })}
      </Text>
      {v.layered.on && v.orgNote ? (
        <Text style={{ fontSize: 12, color: C.red }} testID="session-prompt-org-note">
          {v.orgNote}
        </Text>
      ) : null}
      <TextInput
        testID="session-prompt-note"
        accessibilityLabel={t("ui-prompts.session.noteA11y")}
        multiline
        value={note}
        onChangeText={(x) => {
          setNote(x);
          setError("");
        }}
        placeholder={t("ui-prompts.session.notePlaceholder")}
        style={box}
      />
      <View style={[s.row, { gap: 8, justifyContent: "space-between", flexWrap: "wrap" }]}>
        <Count n={note.trim().length} max={max} />
        <Button
          testID="session-prompt-save"
          busy={busy === "note"}
          disabled={note.trim() === own || note.trim().length > max}
          onPress={() =>
            void run(
              "note",
              () => client.saveSessionPromptExtra(sessionId, { note }),
              t("ui-prompts.session.saved"),
            )
          }
        >
          {t("ui-prompts.session.save")}
        </Button>
      </View>
      {(v.optional || []).map((o) => (
        <View key={o.key} style={{ gap: 2 }}>
          <OptionalRow
            testID={`session-prompt-${o.key}`}
            title={o.title}
            state={t(o.own === null ? "ui-prompts.session.stateFollow" : "ui-prompts.session.stateOwn", {
              state: onOff(t, o.on),
            })}
            action={t(o.on ? "ui-prompts.action.turnOff" : "ui-prompts.action.turnOn")}
            busy={busy === o.key}
            onPress={() =>
              void run(
                o.key,
                () =>
                  client.saveSessionPromptExtra(sessionId, {
                    sections: { [o.key]: !o.on } as Partial<
                      Record<PromptOptional, boolean>
                    >,
                  }),
                t(o.on ? "ui-prompts.session.doneOff" : "ui-prompts.session.doneOn", { title: o.title }),
              )
            }
          />
          {o.own === null ? null : (
            <Pressable
              testID={`session-prompt-${o.key}-follow`}
              accessibilityRole="button"
              onPress={() =>
                void run(
                  o.key,
                  () =>
                    client.saveSessionPromptExtra(sessionId, {
                      sections: { [o.key]: null } as Partial<
                        Record<PromptOptional, null>
                      >,
                    }),
                  t("ui-prompts.session.doneFollow", { title: o.title }),
                )
              }
            >
              <Text style={{ fontSize: 11, textDecorationLine: "underline" }}>
                {t("ui-prompts.session.follow")}
              </Text>
            </Pressable>
          )}
        </View>
      ))}
      <Text style={[s.muted, { fontSize: 12 }]} testID="session-prompt-effect">
        {v.effectText}
      </Text>
      <ApplyNow
        state={v}
        busy={busy === "apply"}
        onPress={() =>
          void run(
            "apply",
            () => client.applySessionPrompt(sessionId),
            t("ui-prompts.session.applied"),
          )
        }
      />
      {saved ? (
        <Text style={[s.muted, { fontSize: 12 }]} testID="session-prompt-saved">
          {saved}
        </Text>
      ) : null}
      {error ? <ErrorBox text={error} /> : null}
      <View style={[s.row, { justifyContent: "flex-end" }]}>
        <Button
          variant="outline"
          testID="session-prompt-open"
          onPress={() => setOpen(true)}
        >
          {t("ui-prompts.session.open")}
        </Button>
      </View>
      {open ? (
        <SessionPromptDialog
          client={client}
          sessionId={sessionId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}
/** One section of one layer: title, state in words, source, who may change it. */
export function GuideLayerCard({ x }: { x: GuideLayer }) {
  const { C } = useDaisyTheme();
  const t = useT();
  const [open, setOpen] = useState(x.layer !== "org");
  const state = x.orphan
    ? t("ui-prompts.card.orphan")
    : x.trimmed
      ? t("ui-prompts.card.trimmed")
      : known(t, `ui-prompts.guideState.${x.state}`, x.state);
  const out = x.state === "disabled" || x.orphan || x.trimmed;
  return (
    <View
      testID={`prompt-layer-${x.id.replace(/:/g, "-")}`}
      style={{
        borderWidth: 1,
        borderColor: x.state === "locked" ? C.orangeLine : C.line,
        backgroundColor: x.state === "locked" ? C.orangeSoft : undefined,
        borderRadius: 8,
        padding: 8,
        gap: 4,
      }}
    >
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={t(open ? "ui-prompts.card.a11yOpen" : "ui-prompts.card.a11yClosed", { title: x.title, state })}
      >
        <Text style={{ color: C.ink, fontWeight: "700", fontSize: 13 }}>
          {x.title}
          <Text style={{ color: C.muted, fontWeight: "400", fontSize: 11 }}>
            {"  "}
            {t("ui-prompts.card.meta", {
              state,
              out: out ? t("ui-prompts.card.out") : "",
              chars: x.chars,
              source: x.source,
              toggle: t(open ? "ui-prompts.card.hide" : "ui-prompts.card.show"),
            })}
          </Text>
        </Text>
      </Pressable>
      {open ? (
        <Text selectable style={{ color: out ? C.muted : C.ink, fontSize: 12 }}>
          {x.text}
        </Text>
      ) : null}
      <Text style={{ color: C.muted, fontSize: 11 }}>
        {t("ui-prompts.card.who", {
          who:
            x.layer === "safety"
              ? t("ui-prompts.card.whoSafety")
              : x.lockedReason
                ? x.lockedReason
                : x.toggle
                  ? t("ui-prompts.card.whoToggle")
                  : x.editable
                    ? t("ui-prompts.card.whoEditable")
                    : t("ui-prompts.card.whoNone"),
        })}
      </Text>
    </View>
  );
}
/** 「本会话的提示词」: read-only, its owner only (12.3). */
export function SessionPromptDialog({
  client,
  sessionId,
  onClose,
}: {
  client: DaisyClient;
  sessionId: string;
  onClose: () => void;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const when = useDaisyTime();
  const [v, setV] = useState<SessionPromptView | null>(null),
    [error, setError] = useState(""),
    [full, setFull] = useState(false);
  const load = useCallback(
    () => client.sessionPrompt(sessionId).then(setV, (e) => setError(e.message)),
    [client, sessionId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const launch = v?.lastLaunch as
    | {
        at?: number;
        runnerBuild?: string;
        engine?: { name?: string; version?: string };
        guideSha256?: string;
        delivery?: string;
        mode?: string;
        note?: string;
        chars?: number;
        instructionFiles?: { path: string; bytes: number }[];
        memoryIndex?: { path: string; bytes: number } | null;
      }
    | null
    | undefined;
  return (
    <Dialog title={t("ui-prompts.dialog.title")} onClose={onClose}>
      {!v ? (
        error ? (
          <ErrorBox text={error} />
        ) : (
          <Text style={s.muted}>{t("ui.common.loading")}</Text>
        )
      ) : (
        <View style={{ gap: 10 }} testID="prompt-view">
          <Text style={[s.muted, { fontSize: 12 }]} testID="prompt-view-status">
            {v.layered.on
              ? t("ui-prompts.dialog.statusOn", { chars: v.chars, max: v.max })
              : t("ui-prompts.dialog.statusOff", { why: v.layered.why ?? "" })}
          </Text>
          <Text style={{ fontSize: 12, color: C.ink }} testID="prompt-view-org">
            {t("ui-prompts.org.line", {
              text:
                v.org && v.org.level !== 4
                  ? v.org.source === "control-plane"
                    ? t("ui-prompts.org.cp", {
                        doc: `${v.org.docId}${v.org.version ? ` v${v.org.version}` : ""}`,
                        sha: v.org.sha256.slice(0, 8),
                        level: levelText(v.org.level, t),
                        time: when.time(v.org.fetchedAt),
                      })
                    : // Only a Runner's report: named by its hash — a version
                      // or level would be a node's word.
                      t("ui-prompts.org.runner", { doc: v.org.docId, sha: v.org.sha256.slice(0, 8) })
                  : t("ui-prompts.org.none"),
              suffix:
                v.org && v.org.level !== 4
                  ? t(v.org.source === "control-plane" ? "ui-prompts.org.suffixCp" : "ui-prompts.org.suffixRunner")
                  : "",
            })}
          </Text>
          {v.orgNote ? (
            <Text
              style={{ fontSize: 12, color: C.red }}
              testID="prompt-view-org-note"
              accessibilityRole="alert"
            >
              {v.orgNote}
            </Text>
          ) : null}
          {LAYER_ORDER.map((name) => {
            const list = v.layers.filter((x) => x.layer === name);
            if (!list.length) return null;
            return (
              <View key={name} style={{ gap: 6 }} testID={`prompt-view-layer-${name}`}>
                <Text style={s.label}>
                  {t("ui-prompts.dialog.layerLabel", {
                    title: t.dynamic(`ui-prompts.layer.${name}`),
                    n: list.length,
                  })}
                </Text>
                {list.map((x) => (
                  <GuideLayerCard key={x.id} x={x} />
                ))}
              </View>
            );
          })}
          <Text style={s.label}>{t("ui-prompts.dialog.perTurn")}</Text>
          {v.perTurn.map((p, i) => (
            <View
              key={i}
              testID="prompt-view-per-turn"
              style={{
                borderWidth: 1,
                borderColor: C.line,
                borderRadius: 8,
                padding: 8,
                gap: 4,
              }}
            >
              <Text style={{ color: C.ink, fontWeight: "700", fontSize: 13 }}>
                {p.title}
              </Text>
              <Text selectable style={{ color: C.ink, fontSize: 12 }}>
                {p.text}
              </Text>
              {p.note ? (
                <Text style={{ color: C.muted, fontSize: 11 }}>{p.note}</Text>
              ) : null}
            </View>
          ))}
          <Text style={s.label}>{t("ui-prompts.dialog.sent")}</Text>
          <Text style={{ fontSize: 12, color: C.ink }} testID="prompt-view-effective">
            {v.effectiveText}
            {v.delivered ? t("ui-prompts.dialog.reported", { time: when.time(v.delivered.at) }) : ""}
          </Text>
          <Text style={[s.muted, { fontSize: 12 }]}>{v.effectText}</Text>
          {launch ? (
            <View style={{ gap: 2 }} testID="prompt-view-launch">
              <Text style={{ fontSize: 12, color: C.ink }}>
                {t("ui-prompts.launch.line", {
                  at: launch.at ? when.time(launch.at) : "—",
                  engine: `${launch.engine?.name || v.agent}${launch.engine?.version ? ` ${launch.engine.version}` : ""}`,
                  build: launch.runnerBuild ? launch.runnerBuild.slice(0, 7) : t("ui-prompts.launch.unknownBuild"),
                  chars: launch.chars ?? 0,
                  sha: (launch.guideSha256 || "").slice(0, 8),
                  delivery: known(t, `ui-prompts.delivery.${launch.delivery || "unknown"}`, launch.delivery || ""),
                  note: launch.note ? t("ui-prompts.paren", { text: launch.note }) : "",
                })}
              </Text>
              {(launch.instructionFiles || []).map((f) => (
                <Text key={f.path} style={{ fontSize: 11, color: C.muted }}>
                  {t("ui-prompts.launch.file", { path: f.path, bytes: f.bytes })}
                </Text>
              ))}
              {launch.memoryIndex ? (
                <Text style={{ fontSize: 11, color: C.muted }}>
                  {t("ui-prompts.launch.memory", { path: launch.memoryIndex.path, bytes: launch.memoryIndex.bytes })}
                </Text>
              ) : null}
            </View>
          ) : (
            <Text style={[s.muted, { fontSize: 12 }]}>
              {t("ui-prompts.launch.none")}
            </Text>
          )}
          <Text style={{ fontSize: 11, color: C.muted }} testID="prompt-view-engine">
            {t("ui-prompts.dialog.engine", {
              owned: v.engineOwned.join(t("ui-prompts.sep")),
              n: v.tools.length,
              tools: v.tools.map((x) => x.name).join(t("ui-prompts.sep")) || t("ui-prompts.dialog.noTools"),
            })}
          </Text>
          <Pressable
            onPress={() => setFull((x) => !x)}
            testID="prompt-view-full-toggle"
            accessibilityRole="button"
          >
            <Text style={{ color: C.accent, fontSize: 12 }}>
              {t(full ? "ui-prompts.dialog.hideFull" : "ui-prompts.dialog.showFull")}
            </Text>
          </Pressable>
          {full ? (
            <Text selectable style={[s.mono, { fontSize: 11 }]} testID="prompt-view-full">
              {v.text}
            </Text>
          ) : null}
          <History rows={v.history} testID="prompt-view-history" />
        </View>
      )}
    </Dialog>
  );
}
export const PROMPT_NOTE_MAX = GUIDE_LIMITS.noteMax;
