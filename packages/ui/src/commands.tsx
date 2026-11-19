import { isAcpAgent, permissionModes, shownName } from "@daisy-ai/contracts";
import React, { useState, useEffect, useRef } from "react";
import { View, ScrollView, Pressable, Modal } from "react-native";
import {
  bypassWarning,
  bypassMode,
  commandList,
  modelChoices,
  tierName,
  STANDARD_TIER,
  GLM_MODEL_SLOTS,
  MODEL_SLOTS,
  OFFICIAL_MODEL_SLOTS,
  glmModelWarning,
  type ModelSlots,
  type AgentCommand,
  type Snapshot,
  type Profile,
} from "@daisy-ai/contracts";
import { DaisyClient, makeId } from "@daisy-ai/client";
import { Text, Button, Field, ErrorBox } from "./primitives";
import { useDaisyFocusScope, useDaisyTheme } from "./theme";
import { useT } from "./i18n";
import { useDaisyCopy, useDaisyHost } from "./host";
import { defaultSaveFile } from "./platform";
import { statusRows } from "./present";
import { REWIND_WORDS, canRewindFiles, rewindPanelText } from "./rewind-copy";
export function CommandPalette({
  commands,
  query,
  index,
  onSelect,
}: {
  commands: AgentCommand[];
  query: string;
  index: number;
  onSelect: (c: AgentCommand) => void;
}) {
  const scroll = useRef<ScrollView>(null);
  const { C, rad } = useDaisyTheme();
  const t = useT();
  const { commandDescriptions } = useDaisyCopy();
  useEffect(() => {
    scroll.current?.scrollTo({
      y: Math.max(0, index * 62 - 100),
      animated: true,
    });
  }, [index]);
  const matches = commands.filter(
    (c) => c.name.includes(query) || c.title.includes(query),
  );
  return (
    <View
      testID="slash-menu"
      style={{
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: rad(12),
        backgroundColor: C.paper,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      <Text style={{ padding: 12, fontSize: 11, color: C.muted }}>
        {t("ui-commands.palette.hint")}
      </Text>
      <ScrollView
        ref={scroll}
        style={{ maxHeight: 235 }}
        keyboardShouldPersistTaps="handled"
      >
        {matches.map((c, i) => (
          <Pressable
            key={c.name}
            testID={`slash-${c.name}`}
            accessibilityRole="button"
            accessibilityLabel={`/${c.name} ${c.title}`}
            onPress={() => onSelect(c)}
            style={{
              padding: 12,
              gap: 4,
              backgroundColor: i === index ? C.soft : C.paper,
            }}
          >
            <Text style={{ fontSize: 13, color: C.ink, fontWeight: "600" }}>
              /{c.name} · {c.title}
            </Text>
            <Text style={{ fontSize: 11, color: C.muted }}>
              {commandDescriptions[c.name] ?? c.description}
            </Text>
          </Pressable>
        ))}
        {!matches.length ? (
          <Text style={{ padding: 12, color: C.muted }}>
            {t("ui-commands.palette.none")}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
export function CommandCenter({
  client,
  snapshot,
  initial,
  onClose,
  onNavigate,
  onInsert,
  onTerminal,
}: {
  client: DaisyClient;
  snapshot: Snapshot;
  initial: string;
  onClose: () => void;
  onNavigate?: (id: string) => void;
  onInsert: (text: string) => void;
  onTerminal: () => void;
}) {
  const [panel, setPanel] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [data, setData] = useState<any>(null),
    [profile, setProfile] = useState<Profile | null>(null),
    [catalog, setCatalog] = useState<any>(null),
    [sessions, setSessions] = useState<any[]>([]),
    [model, setModel] = useState(""),
    [effort, setEffort] = useState(""),
    // Codex service tier ("" default, "default" 标准, "priority" Fast).
    [tier, setTier] = useState(""),
    [permission, setPermission] = useState(""),
    [sandbox, setSandbox] = useState("workspace-write"),
    // the identity's model slots (Claude Code).
    [slots, setSlots] = useState<ModelSlots>({}),
    [name, setName] = useState(""),
    [content, setContent] = useState(""),
    [version, setVersion] = useState(""),
    [count, setCount] = useState("1"),
    [marketplace, setMarketplace] = useState(""),
    // Idempotency key for "new conversation": a retry after a lost response
    // returns the session already created (M5).
    [newRequestId, setNewRequestId] = useState(makeId);
  const { C, s, rad, sp } = useDaisyTheme();
  const { adapters, copy } = useDaisyHost();
  const t = useT();
  const focusScope = useDaisyFocusScope() as any;
  const alive = useRef(true),
    request = useRef<{
      key: string;
      id: string;
      job?: { id: string; sessionId: string };
    } | null>(null);
  const session = snapshot.session,
    agent = session.agent;
  // N-7: 「同时撤销文件」 in the /rewind panel (off by default).
  const [rewindFilesOn, setRewindFilesOn] = useState(false);
  const filesOffered = canRewindFiles(agent, snapshot.rewindFiles);
  useEffect(() => {
    alive.current = true;
    void client
      .catalog()
      .then((c) => {
        if (!alive.current) return;
        setCatalog(c);
        const p = c.profiles.find((x) => x.id === session.profileId);
        if (p) {
          setProfile(p);
          // this conversation's own choice wins over the identity's.
          setModel(session.settings?.model ?? p.model);
          setEffort(
            session.settings?.reasoningEffort ?? p.reasoningEffort ?? "",
          );
          // "" = the identity's tier, so saving a model alone does
          // not pin the identity's tier on this conversation.
          setTier(session.settings?.serviceTier ?? "");
          setPermission(
            p.permissionMode || permissionModes(agent).default,
          );
          setSandbox(p.sandboxMode || "workspace-write");
          setSlots(p.modelSlots || {});
        }
      })
      .catch((e) => setError(e.message));
    void client
      .sessions()
      .then(setSessions)
      .catch(() => {});
    return () => {
      alive.current = false;
    };
  }, [client, session.id]);
  const run = async (op: string, args: Record<string, any> = {}) => {
    setBusy(true);
    setError("");
    const key = JSON.stringify({ op, args });
    if (request.current?.key !== key) request.current = { key, id: makeId() };
    try {
      const ref = request.current;
      ref.job ??= await client.operation(session.id, op, args, ref.id);
      const until = Date.now() + 180000;
      while (alive.current && Date.now() < until) {
        const r = await client.operationStatus(ref.job.sessionId, ref.job.id);
        if (r.result) {
          if (r.result.error) {
            request.current = null;
            throw Error(r.result.error);
          }
          setData(r.result);
          request.current = null;
          if (op === "config.read") {
            setContent(JSON.stringify(r.result.value, null, 2));
            setVersion(r.result.version);
          }
          if (op === "fork") {
            onNavigate?.(ref.job.sessionId);
            onClose();
          }
          return r.result;
        }
        if (["error", "interrupted"].includes(r.status)) {
          request.current = null;
          throw Error(t("ui-commands.op.stopped"));
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (alive.current)
        throw Error(t("ui-commands.op.background"));
    } catch (e: any) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const change = (p: string) => {
    setPanel(p);
    setData(null);
    setError("");
  };
  // P4-11 (C-3): only what the session's AI declares.
  const actions = commandList(
    agent,
    session.commandCatalog?.commands,
    snapshot.features,
    t,
  );
  const choose = (c: AgentCommand) => {
    if (c.kind === "prompt") {
      onInsert((agent === "codex" ? "$" : "/") + c.name + " ");
      onClose();
    } else if (c.name === "terminal") {
      onTerminal();
      onClose();
    } else change(c.name);
  };
  const update = async () => {
    if (!profile) return;
    setBusy(true);
    setError("");
    try {
      if (panel === "model") {
        // model / effort for this conversation only.
        await client.updateSession(session.id, {
          settings: {
            model,
            reasoningEffort: effort,
            ...(agent === "codex" ? { serviceTier: tier } : {}),
          },
        });
        setData({
          saved: true,
          message: t("ui-commands.model.saved", {
            more: isAcpAgent(agent)
              ? ""
              : // applied before the next turn, the process kept.
                t("ui-commands.model.savedLive"),
          }).trim(),
        });
        return;
      }
      await client.request(`/profiles/${profile.id}`, "PATCH", {
        model,
        reasoningEffort: effort,
        // No serviceTier: this conversation's tier is not the identity's
        // (absent = the identity keeps its own).
        permissionMode: permission,
        ...(agent === "codex" ? { sandboxMode: sandbox } : {}),
      });
      setData({
        saved: true,
        message: t("ui-commands.permissions.saved", {
          more: isAcpAgent(agent) ? "" : t("ui-commands.permissions.savedLive"),
        }).trim(),
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const chips = (
    values: string[],
    value: string,
    set: (v: string) => void,
    label: (v: string) => string = (v) => v || t("ui-commands.default"),
  ) => (
    <View style={[s.row, { flexWrap: "wrap" }]}>
      {values.map((v) => (
        <Button
          key={v}
          variant={v === value ? "primary" : "soft"}
          onPress={() => set(v)}
        >
          {label(v)}
        </Button>
      ))}
    </View>
  );
  const tokens = (n: unknown) =>
    typeof n !== "number"
      ? "?"
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}K`
        : String(n);
  // A sentence when there is one (saved settings, /compact), JSON otherwise.
  const json =
    typeof data?.message === "string" ? (
      <Text testID="command-result" style={{ fontSize: 13, color: C.ink }}>
        {data.message}
      </Text>
    ) : panel === "compact" && data?.completed ? (
      <Text testID="command-result" style={{ fontSize: 13, color: C.ink }}>
        {data.preTokens !== undefined
          ? t("ui-commands.compact.doneSizes", {
              before: tokens(data.preTokens),
              after: tokens(data.postTokens),
              took: data.durationMs
                ? t("ui-commands.compact.took", {
                    seconds: (data.durationMs / 1000).toFixed(1),
                  })
                : "",
            })
          : t("ui-commands.compact.done")}
      </Text>
    ) : (
      <ScrollView style={{ maxHeight: 300 }} nestedScrollEnabled>
        <Text selectable style={[s.mono, { fontSize: 11 }]}>
          {JSON.stringify(data, null, 2)}
        </Text>
      </ScrollView>
    );
  const nativeModels = data?.models || session.commandCatalog?.models || [];
  // efforts / Fast as the native catalog lists them for the model.
  const configOptions =
    data?.configOptions || session.commandCatalog?.configOptions || [];
  const choicesFor = (m: string) =>
    modelChoices(agent, {
      models: nativeModels,
      configOptions,
      model: m,
      effort,
      tier,
    });
  const choices = choicesFor(model);
  const chosenEffort = choices.efforts.find((e) => e.value === effort),
    chosenTier = choices.tiers.find((t) => t.id === tier);
  const pickModel = (m: string) => {
    setModel(m);
    // A choice the newly picked model does not list goes back to default.
    const next = modelChoices(agent, { models: nativeModels, model: m });
    if (
      next.fromCatalog &&
      effort &&
      !next.efforts.some((e) => e.value === effort)
    )
      setEffort("");
    if (
      agent === "codex" &&
      next.fromCatalog &&
      tier &&
      tier !== STANDARD_TIER &&
      !next.tiers.some((t) => t.id === tier)
    )
      setTier("");
  };
  const render = () => {
    if (panel === "help")
      return (
        <>
          <Text style={s.muted}>
            {t("ui-commands.help.intro")}
          </Text>
          <Button busy={busy} onPress={() => void run("catalog")}>
            {t("ui-commands.help.refresh")}
          </Button>
          {[
            ...actions,
            ...(data?.commands || []).filter(
              (c: AgentCommand) => !actions.some((a) => a.name === c.name),
            ),
          ].map((c) => (
            <Pressable
              key={c.name}
              accessibilityRole="button"
              onPress={() => choose(c)}
              style={{
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderColor: C.line,
              }}
            >
              <Text style={s.h3}>
                /{c.name} · {c.title}
              </Text>
              <Text style={s.muted}>
                {copy.commandDescriptions[c.name] ?? c.description}
              </Text>
            </Pressable>
          ))}
        </>
      );
    if (panel === "status")
      // N-5: model / reasoning effort as the Agent reported them, and the
      // usage the harness reports; 「不可用」 with the reason otherwise.
      return (
        <>
          {statusRows(
            session,
            {
              account: profile ? shownName("profile", profile, t) : undefined,
              node: (() => {
                const n = catalog?.nodes.find((n: any) => n.id === session.nodeId);
                return n ? shownName("node", n, t) : undefined;
              })(),
              directory: catalog?.workspaces.find(
                (w: any) => w.id === session.workspaceId,
              )?.path,
            },
            snapshot.items,
          ).map((r, i) => (
            <View
              key={r.label}
              testID={`status-row-${r.label}`}
              style={{
                paddingVertical: 6,
                borderBottomWidth: 1,
                borderColor: C.line,
              }}
            >
              <Text selectable>
                <Text style={s.muted}>{t("ui-commands.status.row", { label: r.label })}</Text>
                {/* The first two rows are the Agent and the state: words from the copy. */}
                {i < 2
                  ? (copy.labels as Record<string, string>)[r.value] ||
                    r.value
                  : r.value}
              </Text>
              {r.note ? (
                <Text selectable style={[s.muted, { fontSize: 12 }]}>
                  {r.note}
                </Text>
              ) : null}
            </View>
          ))}
        </>
      );
    if (panel === "new")
      return (
        <>
          <Field
            label={t("ui-commands.new.nameLabel")}
            value={name}
            onChange={setName}
            placeholder={t("ui-commands.new.defaultTitle")}
          />
          <Button
            busy={busy}
            onPress={() => {
              setBusy(true);
              void client
                .create({
                  requestId: newRequestId,
                  agent,
                  title: name || t("ui-commands.new.defaultTitle"),
                  profileId: session.profileId,
                  workspaceId: session.workspaceId,
                })
                .then((s) => {
                  setNewRequestId(makeId());
                  onNavigate?.(s.id);
                  onClose();
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            {t("ui-commands.new.create")}
          </Button>
        </>
      );
    if (panel === "resume")
      return (
        <>
          {sessions
            .filter((s) => s.agent === agent && !s.archived)
            .map((s) => (
              <Button
                key={s.id}
                variant="soft"
                onPress={() => {
                  onNavigate?.(s.id);
                  onClose();
                }}
              >
                {s.title}
              </Button>
            ))}
        </>
      );
    if (panel === "model" || panel === "permissions")
      return (
        <>
          <Text style={s.muted}>
            {panel === "model"
              ? t("ui-commands.model.scope", {
                  current: session.runtime?.model
                    ? t("ui-commands.model.current", {
                        runtime: [
                          session.runtime.model,
                          session.runtime.effort,
                          session.runtime.serviceTier &&
                          session.runtime.serviceTier !== STANDARD_TIER
                            ? tierName(session.runtime.serviceTier, nativeModels, t)
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · "),
                      })
                    : "",
                }).trim()
              : t("ui-commands.permissions.scope", {
                  // what this conversation's process reported.
                  current: session.runtime?.permissionMode
                    ? t("ui-commands.permissions.current", {
                        mode: session.runtime.permissionMode,
                      })
                    : "",
                }).trim()}
          </Text>
          {panel === "model" ? (
            <>
              <Button
                busy={busy}
                variant="soft"
                onPress={() => void run("models")}
              >
                {t("ui-commands.model.readList")}
              </Button>
              {nativeModels.map((m: any) => (
                <Button
                  key={m.id || m.value || m.model}
                  variant="soft"
                  onPress={() => pickModel(m.model || m.value || m.id)}
                >
                  {m.displayName ||
                    m.display_name ||
                    m.name ||
                    m.model ||
                    m.value ||
                    m.id}
                </Button>
              ))}
              <Field
                label={t("ui-commands.model.label")}
                value={model}
                onChange={setModel}
                placeholder={t("ui-commands.model.placeholder")}
              />
              <Text style={s.label}>{t("ui-commands.model.effort")}</Text>
              {chips(
                choices.efforts.map((e) => e.value),
                effort,
                setEffort,
              )}
              {chosenEffort?.description ? (
                <Text testID="effort-description" style={s.muted}>
                  {t("ui-commands.model.describe", { name: chosenEffort.value, description: chosenEffort.description })}
                </Text>
              ) : null}
              {agent === "codex" && choices.tiers.length ? (
                <>
                  <Text style={s.label}>{t("ui-commands.model.speed")}</Text>
                  {chips(
                    ["", ...choices.tiers.map((x) => x.id), STANDARD_TIER],
                    tier,
                    setTier,
                    (v) =>
                      v === ""
                        ? profile?.serviceTier &&
                          profile.serviceTier !== STANDARD_TIER
                          ? t("ui-commands.model.defaultTier", {
                              tier: tierName(profile.serviceTier, nativeModels, t),
                            })
                          : t("ui-commands.default")
                        : v === STANDARD_TIER
                          ? t("ui-commands.model.standard")
                          : choices.tiers.find((x) => x.id === v)?.name || v,
                  )}
                  {chosenTier?.description ? (
                    <Text testID="tier-description" style={s.muted}>
                      {t("ui-commands.model.describe", { name: chosenTier.name, description: chosenTier.description })}
                    </Text>
                  ) : null}
                </>
              ) : null}
              {agent === "codex" && !choices.fromCatalog ? (
                <Text style={s.muted}>
                  {t("ui-commands.model.catalogHint")}
                </Text>
              ) : null}
            </>
          ) : (
            <>
              {/* P4-10: an ACP harness without modes (Antigravity, DeepSeek Harness) shows none. */}
              {permissionModes(agent).values.length ? (
                <>
                  <Text style={s.label}>{t("ui-commands.permissions.native")}</Text>
                  {chips(
                    permissionModes(agent).values,
                    permission,
                    setPermission,
                  )}
                </>
              ) : null}
              {agent === "codex" ? (
                <>
                  <Text style={s.label}>{t("ui-commands.permissions.sandbox")}</Text>
                  {chips(
                    ["read-only", "workspace-write", "danger-full-access"],
                    sandbox,
                    setSandbox,
                  )}
                </>
              ) : null}
              <Text style={s.muted}>{copy.approvalRelaxNote}</Text>
              {/* Bypass anywhere says 「不鼓励」, and why it may be refused. */}
              {bypassMode({
                agent,
                permissionMode: permission,
                sandboxMode: agent === "codex" ? sandbox : undefined,
              }) ? (
                <Text
                  testID="bypass-warning"
                  style={{ color: C.red, fontWeight: "600" }}
                >
                  {bypassWarning(t)}
                </Text>
              ) : null}
            </>
          )}
          <Button busy={busy} onPress={() => void update()}>
            {t("ui-commands.settings.save")}
          </Button>
          {data?.saved ? json : null}
        </>
      );
    if (panel === "identity") {
      // same Agent, same node, the owner's own identities.
      const others = (catalog?.profiles || []).filter(
        (p: Profile) =>
          p.agent === agent &&
          p.nodeId === session.nodeId &&
          p.id !== session.profileId,
      );
      const switchTo = async (p: Profile) => {
        setBusy(true);
        setError("");
        try {
          await client.request(`/sessions/${session.id}/identity`, "POST", {
            profileId: p.id,
          });
          setData({
            saved: true,
            message: t("ui-commands.identity.switched", { profile: shownName("profile", p, t) }),
          });
          setProfile(p);
          setSlots(p.modelSlots || {});
        } catch (e: any) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      };
      const saveSlots = async () => {
        if (!profile) return;
        setBusy(true);
        setError("");
        try {
          await client.request(`/profiles/${profile.id}`, "PATCH", {
            modelSlots: Object.fromEntries(
              MODEL_SLOTS.map((k) => [k, (slots[k] || "").trim()]),
            ),
          });
          setData({
            saved: true,
            message: t("ui-commands.identity.slotsSaved"),
          });
        } catch (e: any) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      };
      return (
        <>
          <Text style={s.muted}>
            {t("ui-commands.identity.current", { profile: profile ? shownName("profile", profile, t) : t("ui-commands.identity.gone") })}
          </Text>
          <Text style={s.label}>{t("ui-commands.identity.switch")}</Text>
          <Text style={s.muted}>
            {t("ui-commands.identity.switchHint")}
          </Text>
          {others.length ? (
            others.map((p: Profile) => (
              <Button
                key={p.id}
                testID={`identity-switch-${p.id}`}
                busy={busy}
                variant="soft"
                onPress={() => void switchTo(p)}
              >
                {shownName("profile", p, t)}
              </Button>
            ))
          ) : (
            <Text style={s.muted}>
              {t("ui-commands.identity.noOthers")}
            </Text>
          )}
          {profile ? (
            <>
              <Text style={s.label}>{t("ui-commands.identity.slots")}</Text>
              <Text style={s.muted}>
                {t("ui-commands.identity.slotsHint")}
              </Text>
              <View style={[s.row, { flexWrap: "wrap" }]}>
                {/* Provider presets (cc-switch): GLM has no fable slot. */}
                <Button
                  testID="slots-preset-glm"
                  variant="soft"
                  onPress={() => setSlots({ ...GLM_MODEL_SLOTS, fable: "" })}
                >
                  {t("ui-commands.identity.presetGlm")}
                </Button>
                <Button
                  testID="slots-preset-official"
                  variant="soft"
                  onPress={() => setSlots({ ...OFFICIAL_MODEL_SLOTS })}
                >
                  {t("ui-commands.identity.presetOfficial")}
                </Button>
              </View>
              {MODEL_SLOTS.map((k) => (
                <Field
                  key={k}
                  label={k}
                  value={slots[k] || ""}
                  onChange={(v) => setSlots((x) => ({ ...x, [k]: v }))}
                  placeholder={t("ui-commands.identity.slotPlaceholder")}
                />
              ))}
              {(() => {
                const w = glmModelWarning({
                  baseUrl: profile.baseUrl,
                  model: profile.model,
                  modelSlots: slots,
                }, t);
                return w ? (
                  <Text
                    testID="glm-model-warning"
                    style={{ color: C.red, fontWeight: "600" }}
                  >
                    {w}
                  </Text>
                ) : null;
              })()}
              <Button busy={busy} onPress={() => void saveSlots()}>
                {t("ui-commands.identity.saveSlots")}
              </Button>
            </>
          ) : null}
          {data?.saved ? json : null}
        </>
      );
    }
    if (panel === "config")
      return (
        <>
          <Text style={s.muted}>
            {t("ui-commands.config.intro")}
          </Text>
          <Button
            busy={busy}
            variant="soft"
            onPress={() => void run("config.read")}
          >
            {t("ui-commands.config.read")}
          </Button>
          {version ? (
            <>
              <Field
                label={t("ui-commands.config.label")}
                value={content}
                onChange={setContent}
                multiline
              />
              <Button
                busy={busy}
                disabled={!profile?.configDir.startsWith("managed:")}
                onPress={() => {
                  try {
                    void run("config.write", {
                      value: JSON.parse(content),
                      version,
                    });
                  } catch {
                    setError(t("ui-commands.config.invalid"));
                  }
                }}
              >
                {t("ui-commands.config.save")}
              </Button>
            </>
          ) : null}
          {data?.saved ? json : null}
        </>
      );
    if (panel === "skills")
      return (
        <>
          <Button
            busy={busy}
            variant="soft"
            onPress={() => void run("catalog")}
          >
            {t("ui-commands.skills.read")}
          </Button>
          {(data?.commands || session.commandCatalog?.commands || []).map(
            (c: AgentCommand) => (
              <Button key={c.name} variant="soft" onPress={() => choose(c)}>
                /{c.name}
              </Button>
            ),
          )}
          <Text style={s.label}>{t("ui-commands.skills.writeTitle")}</Text>
          <Field
            label={t("ui-commands.skills.name")}
            value={name}
            onChange={setName}
            placeholder="my-skill"
          />
          <Field
            label={t("ui-commands.skills.content")}
            value={content}
            onChange={setContent}
            multiline
          />
          <Button
            busy={busy}
            onPress={() => void run("skill.write", { name, content })}
          >
            {t("ui-commands.skills.save")}
          </Button>
          {data ? json : null}
        </>
      );
    if (panel === "mcp" || panel === "plugins")
      return (
        <>
          <Button busy={busy} variant="soft" onPress={() => void run(panel)}>
            {panel === "mcp" ? t("ui-commands.mcp.read") : t("ui-commands.plugins.read")}
          </Button>
          {data ? json : null}
          <Field
            label={panel === "mcp" ? t("ui-commands.mcp.name") : t("ui-commands.plugins.name")}
            value={name}
            onChange={setName}
          />
          {panel === "mcp" ? (
            <Field
              label={t("ui-commands.mcp.config")}
              value={content}
              onChange={setContent}
              multiline
              placeholder={'{"command":"...","args":[]}'}
            />
          ) : (
            <Field
              label={t("ui-commands.plugins.marketplace")}
              value={marketplace}
              onChange={setMarketplace}
            />
          )}
          <Text style={s.muted}>
            {t("ui-commands.ext.warning")}
          </Text>
          <View style={[s.row, { flexWrap: "wrap" }]}>
            <Button
              busy={busy}
              onPress={() => {
                try {
                  void run(panel === "mcp" ? "mcp.add" : "plugin.install", {
                    name,
                    ...(panel === "mcp"
                      ? { config: JSON.parse(content) }
                      : { marketplace }),
                  });
                } catch {
                  setError(t("ui-commands.mcp.invalid"));
                }
              }}
            >
              {t("ui-commands.ext.add")}
            </Button>
            <Button
              busy={busy}
              variant="ghost"
              onPress={() =>
                void run(panel === "mcp" ? "mcp.remove" : "plugin.uninstall", {
                  name,
                })
              }
            >
              {t("ui-commands.ext.remove")}
            </Button>
          </View>
        </>
      );
    if (["fork", "rewind", "compact", "review"].includes(panel))
      return (
        <>
          <Text style={s.muted}>
            {panel === "fork"
              ? t("ui-commands.fork.intro")
              : panel === "rewind"
                ? rewindPanelText(agent, rewindFilesOn, snapshot.rewindFiles)
                : panel === "compact"
                  ? t("ui-commands.compact.intro")
                  : t("ui-commands.review.intro")}
          </Text>
          {panel === "rewind" ? (
            <Field label={t("ui-commands.rewind.count")} value={count} onChange={setCount} />
          ) : null}
          {panel === "rewind" && filesOffered ? (
            // N-7: the same 「同时撤销文件」 as the edit banner.
            <Button
              testID="rewind-panel-files"
              variant="soft"
              onPress={() => setRewindFilesOn((v) => !v)}
            >
              {rewindFilesOn
                ? REWIND_WORDS.filesToggleOn
                : REWIND_WORDS.filesToggle}
            </Button>
          ) : null}
          <Button
            busy={busy}
            onPress={() =>
              void run(
                panel,
                panel === "rewind"
                  ? {
                      count: Number(count),
                      ...(rewindFilesOn && filesOffered ? { files: true } : {}),
                    }
                  : {},
              )
            }
          >
            {t("ui-commands.confirm", { action: actions.find((c) => c.name === panel)?.title || panel })}
          </Button>
          {data ? json : null}
        </>
      );
    if (panel === "stop")
      return (
        <Button
          busy={busy}
          onPress={() => {
            void client
              .cancel(session.id)
              .then(onClose)
              .catch((e) => setError(e.message));
          }}
        >
          {t("ui-commands.stop.button")}
        </Button>
      );
    if (panel === "export")
      return (
        <>
          <Text style={s.muted}>
            {t("ui-commands.export.intro")}
          </Text>
          <Button
            onPress={async () => {
              const text = JSON.stringify(snapshot, null, 2),
                request = {
                  kind: "export" as const,
                  name: `daisy-${session.id}.json`,
                  mimeType: "application/json",
                  text,
                  read: async () =>
                    new Blob([text], { type: "application/json" }),
                };
              try {
                await (adapters.saveFile
                  ? adapters.saveFile(request)
                  : defaultSaveFile(request, client));
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            {t("ui-commands.export.button")}
          </Button>
          <Text selectable style={s.mono}>
            {data ? JSON.stringify(data, null, 2) : ""}
          </Text>
        </>
      );
    if (panel === "terminal")
      return (
        <Button
          onPress={() => {
            onTerminal();
            onClose();
          }}
        >
          {t("ui-commands.terminal.open")}
        </Button>
      );
    return <Text style={s.muted}>{t("ui-commands.pick")}</Text>;
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View
        {...focusScope}
        style={{
          flex: 1,
          backgroundColor: C.overlay,
          justifyContent: "center",
          alignItems: "center",
          padding: 20,
        }}
      >
        <View
          style={{
            width: "100%",
            maxWidth: 680,
            maxHeight: "90%",
            backgroundColor: C.paper,
            borderRadius: rad(18),
            overflow: "hidden",
          }}
        >
          <View
            style={[
              s.row,
              { padding: sp(20), borderBottomWidth: 1, borderColor: C.line },
            ]}
          >
            <Pressable
              accessibilityRole="button"
              onPress={() => change("help")}
            >
              <Text style={{ color: C.accent }}>{t("ui-commands.title")}</Text>
            </Pressable>
            <Text style={[s.h3, { flex: 1 }]}>/{panel}</Text>
            <Button variant="ghost" onPress={onClose}>
              {t("ui-commands.close")}
            </Button>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: sp(20), gap: sp(14) }}
          >
            <ErrorBox text={error} />
            {render()}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
