import { AGENT_IDS, acpHarness, agentLetter, harnessText, shownName } from "@daisy-ai/contracts";
/**
 * Logout: empties the AI conversation snapshots this page keeps (memory
 * only) and tells other tabs. Hosts call it on logout; dispatching the
 * host's logout `window` event (setHostConventions) does the same.
 */
export { clearSessionCache } from "./session-cache";
export { DaisySessionView } from "./agent-session";
// fetch a conversation ahead of opening it (hover / intent), and the
// freshness model hosts use for their own views.
export {
  prefetchSnapshot as prefetchSession,
  SESSION_TAIL,
} from "./session-cache";
export {
  aiPresence,
  ageText,
  freshnessKind,
  freshnessReducer,
  freshnessText,
  initialFreshness,
  useDelayed,
  useFreshness,
  useTicking,
  viewFreshness,
  type AiPresence,
  type Freshness,
  type FreshnessEvent,
  type FreshnessKind,
} from "./freshness";
import { DaisySessionView } from "./agent-session";
import {
  SidebarRail,
  SidebarToggle,
  useSidebarCollapsed,
} from "./sidebar-collapse";
import { Text } from "./primitives";
import { readMigrated } from "./storage-keys";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  ScrollView,
  Pressable,
  Modal,
  Platform,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  DaisyClient,
  DaisyError,
  makeId,
  type Catalog,
} from "@daisy-ai/client";
import type {
  Agent,
  NodeInfo,
  Profile,
  Session,
  TaskContext,
  User,
} from "@daisy-ai/contracts";
import { WorkspacePicker } from "./workspace";
import { DaisyChat } from "./chat";
import { clearDraft } from "./drafts";
import { backgroundCount, safeHostHref } from "./present";
import { Settings } from "./settings";
import { t as uiT, useT } from "./i18n";
import { CallRequestList, useCallRequestCount } from "./sharing";
import { DaisyApprovalList } from "./approval-inbox";
import { clearSessionCache } from "./session-cache";
import { C, Button, Field, Badge, ErrorBox } from "./primitives";
import { codeFromInput, codeProblem } from "./open-code";
import {
  DaisyThemeProvider,
  daisyPhaseColor,
  useDaisyFocusScope,
  useDaisyTheme,
  withAlpha,
  type DaisyTheme,
  type DaisyThemeInput,
} from "./theme";
import {
  DaisyHostProvider,
  daisySessionPhase,
  phaseLabelKey,
  useDaisyCopy,
  useDaisyHost,
  useDaisyTime,
  useHostOrigins,
  type DaisyCopy,
  type DaisyHostAdapters,
} from "./host";
import { COMMAND_NAME } from "@daisy-ai/contracts";
import { PinBanner, PinHistoryLine, PinProvider } from "./pin";
import {
  NotificationList,
  NotificationsButton,
  SessionMark,
  useSessionNotifications,
} from "./notifications";
export { DaisyChat };
export type { DaisyChatProps, DaisyChatLoadError } from "./chat";
/** Official Agent account login card, for a host settings page. */
export { DaisyAgentLogin } from "./login";
// P4-12 (ADR-132): the 「对外」 pages (settings) and the call cards (workbench).
export { SharingSettings, CallRequestList } from "./sharing";
// the composer's context ring + bubble, the identity's threshold.
export { ContextGaugeButton } from "./context-gauge";
export { AutoCompactSetting } from "./auto-compact";
export type { DaisyAgentLoginProps } from "./login";
export type {
  MessageContext,
  MessageContextInput,
  RelatedTask,
} from "@daisy-ai/contracts";
/** @deprecated Default palette only; theme through DaisyThemeProvider. */
export { C as daisyColors };
export * from "./theme";
export {
  DaisyHostProvider,
  useDaisyHost,
  useDaisyCopy,
  useOpenUrl,
  defaultDaisyCopy,
  toolAuthorizationCopy,
  type DaisyCopy,
  type DaisyHostAdapters,
  type DaisyPickedFile,
  type DaisyFileRequest,
  type DaisyChatPhase,
  type DaisyChatStatus,
  daisySessionPhase,
  phaseLabelKey,
  useDaisyTime,
  useHostOrigins,
} from "./host";
export {
  safeHostHref,
  daisyPhaseTone,
  daisyTimeFormat,
  contextGauge,
  contextBubble,
  cacheRate,
  autoCompactView,
  type ContextGauge,
  type BubbleRow,
  type DaisyPhaseTone,
  type DaisyTimeOptions,
} from "./present";
export { daisyChatPhase } from "./chat";
export { codeFromHash, codeFromInput, codeProblem } from "./open-code";
export { clearDraft } from "./drafts";
export { hostBrandingProps, type DaisyBrandingProps } from "./branding";
/** P4-10: the native agents, then every ACP harness (acp-harnesses.ts). */
export const agents = AGENT_IDS as Agent[];
/** P5-03: what a pairing gave this device — kept on it (the secret is not shown again). */
export {
  parsePairedDevice,
  forgetPairedDevice,
  pairedDeviceForPage,
  keptSessionToken,
  type PairedDevice,
} from "./device-store";
export {
  pairedDeviceClient,
  restorePairedDevice,
  watchPageShown,
  pairCodeFromHash,
  credentialRefused,
  deviceInvalid,
  type PairedDeviceClient,
  type PairedDeviceKeep,
  type DeviceCheck,
} from "./device-session";
export { BootGuard, withinBoot, BOOT_LIMIT_MS } from "./boot-guard";
export { readMigrated, legacyStorageKey } from "./storage-keys";
// P6-20 (ADR-159): the UI's language (an embedding host calls loadUiLanguage once).
export { loadUiLanguage, setUiPack, useT, t as uiText, uiLanguageLoaded } from "./i18n";
export { LanguageSettings } from "./language-settings";
import type { PairedDevice } from "./device-store";
/** P5-03: a first name for this device, from its browser (the owner sees it in 设置 › 设备). */
export function guessDeviceName(): string {
  const ua = typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  const browser = /EdgA?\//.test(ua)
    ? "Edge"
    : /CriOS|Chrome\//.test(ua)
      ? "Chrome"
      : /FxiOS|Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return [os, browser].filter(Boolean).join(" · ") || uiT("ui-app.device.defaultName");
}
/**
 * P1-03 (5.12, ADR-110): opening the web page. No accounts, no passwords:
 * the page trades the one-time passcode `daisy open` printed (in the link
 * after `#code=`, or typed here) for its session. On this machine with the
 * passcode off the app gets a session without this screen.
 *
 * P5-03 (ADR-142): or this device is paired — the owner made a pairing
 * code (`daisy pair`, 设置 › 设备); typed here (or in the link after
 * `#pair=`), it gives this device its own credential, kept on it, so it
 * stays logged in (`onLogin(client, device)`).
 */
export function LoginScreen({
  defaultUrl,
  onLogin,
  showUrl = false,
  initialError = "",
  initialPairCode = "",
}: {
  defaultUrl: string;
  /** `device`: this device was just paired (keep its credential). */
  onLogin: (c: DaisyClient, device?: PairedDevice) => void;
  /** Native app: the address of the Daisy to open (web: this page's own). */
  showUrl?: boolean;
  initialError?: string;
  /** P5-03: a pairing code from the link (`#pair=`): open in the pairing mode, filled in. */
  initialPairCode?: string;
}) {
  const [url, setUrl] = useState(defaultUrl),
    [code, setCode] = useState(""),
    [error, setError] = useState(initialError),
    [busy, setBusy] = useState(false),
    [pairing, setPairing] = useState(!!initialPairCode),
    [pairCode, setPairCode] = useState(initialPairCode),
    [deviceName, setDeviceName] = useState(() => guessDeviceName());
  const { width } = useWindowDimensions();
  const { C, s } = useDaisyTheme();
  const t = useT();
  const { labels, productName } = useDaisyCopy();
  const login = async () => {
    setBusy(true);
    setError("");
    try {
      if (!/^https?:\/\//.test(url))
        throw Error(t("ui-app.login.urlInvalid"));
      const client = new DaisyClient(url, "");
      if (pairing) {
        const r = await client.redeemPairing(pairCode.trim(), deviceName.trim() || undefined);
        // Review M-2: the Daisy it paired with — its credential goes nowhere else.
        onLogin(client, { id: r.deviceId, secret: r.secret, name: r.name, url: client.baseUrl });
        return;
      }
      // P4N-5: a whole link pasted here works too; a value that cannot be
      // a passcode (a password the browser filled in) is said plainly.
      const typed = codeFromInput(code);
      const problem = codeProblem(typed);
      if (problem) throw Error(problem);
      await client.webSession(typed);
      onLogin(client);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          flexDirection: width > 900 ? "row" : "column",
        }}
      >
        {width > 900 ? (
          <View
            style={{
              flex: 1,
              backgroundColor: C.heroBg,
              padding: 65,
              justifyContent: "space-between",
            }}
          >
            <Text
              style={{ color: C.heroAccent, fontSize: 18, fontWeight: "600" }}
            >
              ✳ {productName.toUpperCase()}
            </Text>
            <View style={{ gap: 22 }}>
              <Text
                style={{
                  fontSize: 48,
                  fontWeight: "600",
                  lineHeight: 62,
                  color: C.heroInk,
                }}
              >
                {t("ui-app.login.heroTitle")}
              </Text>
              <Text
                style={{
                  fontSize: 16,
                  color: C.heroMuted,
                  lineHeight: 28,
                  maxWidth: 400,
                }}
              >
                {t("ui-app.login.heroBody")}
              </Text>
              <View style={[s.row, { marginTop: 10 }]}>
                {agents.map((a) => (
                  <View
                    key={a}
                    style={{
                      padding: 12,
                      borderWidth: 1,
                      borderColor: C.heroLine,
                      borderRadius: 9,
                    }}
                  >
                    <Text style={{ fontSize: 12, color: C.heroChip }}>
                      {labels[a]}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
            <Text style={{ color: C.heroFaint, fontSize: 11 }}>
              YOUR MACHINE / YOUR AGENTS.
            </Text>
          </View>
        ) : null}
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            padding: 30,
          }}
        >
          <View style={{ width: "100%", maxWidth: 370, gap: 21 }}>
            <View style={{ gap: 10 }}>
              <Text style={{ fontSize: 34, color: C.accent }}>✳</Text>
              <Text style={s.title}>{t("ui-app.login.welcome")}</Text>
              <Text style={s.muted}>
                {pairing
                  ? t("ui-app.login.pairIntro")
                  : t("ui-app.login.codeIntro")}
              </Text>
            </View>
            {showUrl ? (
              <Field
                label={t("ui-app.login.url")}
                value={url}
                onChange={setUrl}
                placeholder={`https://${COMMAND_NAME}.example.com`}
              />
            ) : null}
            {pairing ? (
              <>
                <Field
                  label={t("ui-app.login.pairCode")}
                  value={pairCode}
                  onChange={setPairCode}
                  secret
                  placeholder="XXXXX-XXXXX"
                  testID="login-pair-code"
                />
                <Field
                  label={t("ui-app.login.deviceName")}
                  value={deviceName}
                  onChange={setDeviceName}
                  testID="login-pair-name"
                />
              </>
            ) : (
              <Field
                label={t("ui-app.login.code")}
                value={code}
                onChange={setCode}
                secret
                // P4N-5: not a saved password for the browser to fill in.
                autoComplete="one-time-code"
                testID="login-code"
              />
            )}
            <ErrorBox text={error} />
            <Button
              testID="login-submit"
              busy={busy}
              onPress={() => void login()}
            >
              {pairing ? t("ui-app.login.pairSubmit") : t("ui-app.login.submit")}
            </Button>
            <Button
              variant="ghost"
              testID="login-pair-toggle"
              onPress={() => {
                setPairing((v) => !v);
                setError("");
              }}
            >
              {pairing ? t("ui-app.login.useCode") : t("ui-app.login.usePair")}
            </Button>
            <Text style={{ fontSize: 11, lineHeight: 19, color: C.faint }}>
              {pairing
                ? t("ui-app.login.pairHelp")
                : t("ui-app.login.codeHelp")}
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { C, s, rad, sp } = useDaisyTheme();
  const focusScope = useDaisyFocusScope() as any;
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
            backgroundColor: C.paper,
            borderRadius: rad(20),
            width: "100%",
            maxWidth: 610,
            maxHeight: "92%",
            overflow: "hidden",
          }}
        >
          <View
            style={[
              s.row,
              { padding: sp(22), borderBottomWidth: 1, borderColor: C.line },
            ]}
          >
            <Text style={[s.h3, { flex: 1 }]}>{title}</Text>
            <Button variant="ghost" onPress={onClose}>
              ✕
            </Button>
          </View>
          <ScrollView
            contentContainerStyle={{ padding: sp(24), gap: sp(18) }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
export function Choices({
  value,
  onChange,
  choices,
}: {
  value: string;
  onChange: (s: string) => void;
  choices: { id: string; label: string }[];
}) {
  const { s } = useDaisyTheme();
  return (
    <View style={[s.row, { flexWrap: "wrap" }]}>
      {choices.map((c) => (
        <Button
          key={c.id}
          variant={value === c.id ? "primary" : "soft"}
          onPress={() => onChange(c.id)}
        >
          {c.label}
        </Button>
      ))}
    </View>
  );
}
/** 「开启新的工作」 dialog. */
export function DaisyNewSession({
  client,
  catalog,
  onClose,
  onCreated,
  task,
  requireTask = false,
  hostName,
  me,
  onCatalogChanged,
}: {
  client: DaisyClient;
  catalog: Catalog;
  /** Signed-in user: a host-login identity is only for one's own nodes. */
  me?: User | null;
  /** Reload the catalog after creating an identity here. */
  onCatalogChanged?: () => Promise<void>;
  onClose: () => void;
  onCreated: (s: Session) => void;
  task?: TaskContext;
  /** The embedding product, for the task field hints. */
  hostName?: string;
  /** Host rule (branding newWork = require-task): every session binds a task. */
  requireTask?: boolean;
}) {
  // 「开启新的工作」: AI → 身份档, linked; then 工作目录; the title is
  // optional (blank = named automatically after the first exchange); the
  // task fields stay, optional and folded away. P1-08: one Daisy, one
  // machine (D-01) — no 执行节点 step; the in-process Runner is the node.
  const remembered = useMemo(loadNewSessionDefaults, []);
  const [pickedAgent, setPickedAgent] = useState<Agent | "">(
      remembered.agent || "",
    ),
    [profile, setProfile] = useState(""),
    [title, setTitle] = useState(task?.title || ""),
    [workspace, setWorkspace] = useState({ nodeId: "", path: "" }),
    [context, setContext] = useState(task?.description || ""),
    [taskTitle, setTaskTitle] = useState(task?.title || ""),
    [taskId, setTaskId] = useState(task?.id || ""),
    [taskOpen, setTaskOpen] = useState(
      requireTask || !!task?.title || !!task?.description,
    ),
    [busy, setBusy] = useState(false),
    [creating, setCreating] = useState(false),
    [error, setError] = useState("");
  const { C, s } = useDaisyTheme();
  const t = useT();
  const { labels } = useDaisyCopy();
  type CatalogNode = (typeof catalog.nodes)[number];
  const usable = (n?: CatalogNode) => !!n && !!n.online;
  // P1-02 / P1-03: this machine's in-process Runner.
  const node = catalog.nodes.find((n) => usable(n)) || catalog.nodes[0],
    nodeId = node?.id || "";
  const installed = (a: Agent) => agentInstalled(node, a);
  const agent: Agent =
    pickedAgent && installed(pickedAgent)
      ? pickedAgent
      : agents.find((a) => a === "claude" && installed(a)) ||
        agents.find(installed) ||
        "claude";
  const byRecent = (a: Profile, b: Profile) =>
    (b.lastAuthenticatedAt || 0) - (a.lastAuthenticatedAt || 0);
  const ps = catalog.profiles
      .filter((x) => x.agent === agent && x.nodeId === nodeId)
      .sort(byRecent),
    rememberedProfile = remembered.profiles?.[`${nodeId}:${agent}`],
    pid = ps.some((x) => x.id === profile)
      ? profile
      : ps.some((x) => x.id === rememberedProfile)
        ? rememberedProfile
        : ps[0]?.id,
    p = ps.find((x) => x.id === pid),
    ws = catalog.workspaces.filter((w) => w.nodeId === nodeId),
    canHostLogin =
      !!node && installed(agent) && !!me,
    home: string = (node?.capabilities.filesystem as any)?.home || "",
    // A registered directory first (the home one if registered): it needs
    // no browsing, which the outside face keeps off by default (P1-08).
    workspacePath =
      workspace.nodeId === nodeId
        ? workspace.path
        : (ws.find((w) => w.path === home) ?? ws[0])?.path || home || "~";
  // One idempotency key per distinct attempt: retrying after a lost response
  // returns the session already created instead of a second one (M5).
  const attempt = useRef<{ key: string; requestId: string; taskId: string }>(
    null,
  );
  const create = async () => {
    setBusy(true);
    try {
      if (!p) throw Error(t("ui-app.new.pickProfile"));
      const key = JSON.stringify([
        agent,
        pid,
        workspacePath,
        title,
        taskId.trim(),
        taskTitle,
        context,
      ]);
      if (attempt.current?.key !== key)
        attempt.current = {
          key,
          requestId: makeId(),
          taskId: `task-${Date.now()}`,
        };
      const { requestId, taskId: fallbackTaskId } = attempt.current;
      if (requireTask && (!taskId.trim() || !taskTitle.trim()))
        throw Error(t("ui-app.new.taskRequired"));
      // A registered directory is used as it is (P1-08: on the outside
      // face, browsing / creating directories is off unless the owner
      // turned it on — a known one must not need it).
      const selectedWorkspace =
        catalog.workspaces.find(
          (w) => w.nodeId === p.nodeId && w.path === workspacePath.trim(),
        ) ?? (await client.ensureWorkspace(p.nodeId, workspacePath));
      const created = await client.create({
        requestId,
        // Blank: the server names it after the first exchange (titleAuto).
        ...(title.trim() ? { title: title.trim() } : {}),
        agent,
        workspaceId: selectedWorkspace.id,
        workspaceMode: "shared",
        profileId: p.id,
        ...(taskTitle || context || requireTask
          ? {
              task: {
                id: taskId.trim() || task?.id || fallbackTaskId,
                title: taskTitle || title.trim() || t("ui-app.new.taskDefaultTitle"),
                description: context,
                ...(task?.metadata ? { metadata: task.metadata } : {}),
                ...(task?.url ? { url: task.url } : {}),
              },
            }
          : {}),
      });
      saveNewSessionDefaults({
        agent,
        profiles: {
          ...remembered.profiles,
          [`${nodeId}:${agent}`]: p.id,
        },
      });
      attempt.current = null;
      onCreated(created);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const step = (n: number, label: string, hint?: string) => (
    <View style={[s.row, { gap: 8, marginTop: 4 }]}>
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: C.soft,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ fontSize: 11, fontWeight: "700", color: C.accent }}>
          {n}
        </Text>
      </View>
      <Text style={s.label}>{label}</Text>
      {hint ? (
        <Text style={[s.muted, { fontSize: 12, flex: 1 }]} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
  return (
    <Dialog title={t("ui-app.new.title")} onClose={onClose}>
      {node && !usable(node) ? (
        <ErrorBox text={t("ui-app.new.notReady")} />
      ) : !node ? (
        <ErrorBox text={t("ui-app.new.starting")} />
      ) : null}
      {step(1, "AI")}
      <View
        style={[s.row, { flexWrap: "wrap", gap: 8 }]}
        testID="new-session-agents"
      >
        {agents.map((a) => (
          <Button
            key={a}
            testID={`new-session-agent-${a}`}
            variant={a === agent ? "primary" : "soft"}
            disabled={!installed(a)}
            accessibilityLabel={
              installed(a) ? labels[a] : t("ui-app.new.notInstalled", { agent: labels[a]! })
            }
            onPress={() => {
              setPickedAgent(a);
              setProfile("");
              setError("");
            }}
          >
            {labels[a]}
          </Button>
        ))}
      </View>
      {agents.some((a) => !installed(a)) ? (
        <Text style={[s.muted, { fontSize: 12 }]}>
          {t("ui-app.new.greyHint")}
        </Text>
      ) : null}
      {step(2, t("ui-app.new.stepProfile"))}
      {ps.length ? (
        <View
          style={[s.row, { flexWrap: "wrap", gap: 8 }]}
          testID="new-session-identities"
        >
          {ps.map((x) => (
            <Button
              key={x.id}
              variant={x.id === pid ? "primary" : "soft"}
              onPress={() => setProfile(x.id)}
            >
              {shownName("profile", x, t)}
            </Button>
          ))}
        </View>
      ) : (
        <View style={{ gap: 8 }} testID="new-session-no-identity">
          <ErrorBox
            text={t("ui-app.new.noProfile", { agent: labels[agent]! })}
          />
          {canHostLogin ? (
            <Button
              variant="soft"
              busy={creating}
              testID="new-session-host-identity"
              onPress={() =>
                void (async () => {
                  setCreating(true);
                  setError("");
                  try {
                    const made = await client.request<Profile>(
                      "/profiles",
                      "POST",
                      {
                        label: t("ui-app.new.hostLoginLabel", { agent: labels[agent]! }),
                        nodeId,
                        agent,
                        authMode: "subscription",
                        configDir: "",
                      },
                    );
                    await onCatalogChanged?.();
                    setProfile(made.id);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setCreating(false);
                  }
                })()
              }
            >
              {t("ui-app.new.hostLoginCreate", { agent: labels[agent]! })}
            </Button>
          ) : null}
        </View>
      )}
      <WorkspacePicker
        client={client}
        nodeId={nodeId}
        nodeLabel={node ? shownName("node", node, t) : ""}
        path={workspacePath}
        onChange={(path) => setWorkspace({ nodeId, path })}
        recent={ws}
        disabled={busy}
      />
      <Field
        label={t("ui-app.new.sessionName")}
        value={title}
        onChange={setTitle}
        placeholder={t("ui-app.new.sessionNamePlaceholder")}
        testID="session-title"
      />
      <View style={{ height: 1, backgroundColor: C.line }} />
      <Pressable
        testID="new-session-task-toggle"
        accessibilityRole="button"
        accessibilityState={{ expanded: taskOpen }}
        onPress={() => setTaskOpen((x) => !x || requireTask)}
        style={[s.row, { gap: 6, paddingVertical: 4 }]}
      >
        <Text style={{ fontSize: 12, color: C.muted }}>
          {taskOpen ? "▾" : "▸"}
        </Text>
        <Text style={s.label}>
          {requireTask ? t("ui-app.new.taskRequiredToggle") : t("ui-app.new.taskOptionalToggle")}
        </Text>
        {!taskOpen && taskTitle ? (
          <Text style={[s.muted, { fontSize: 12, flex: 1 }]} numberOfLines={1}>
            {taskTitle}
          </Text>
        ) : null}
      </Pressable>
      {taskOpen ? (
        <View style={{ gap: 10 }} testID="new-session-task">
          {requireTask ? (
            <Field
              label={t("ui-app.new.taskId")}
              value={taskId}
              onChange={setTaskId}
              placeholder={t("ui-app.new.taskIdPlaceholder", { system: hostName || t("ui-app.new.taskSystem") })}
              testID="session-task-id"
            />
          ) : null}
          <Field
            label={requireTask ? t("ui-app.new.taskTitleRequired") : t("ui-app.new.taskTitle")}
            value={taskTitle}
            onChange={setTaskTitle}
            placeholder={t("ui-app.new.taskTitlePlaceholder", { system: hostName || t("ui-app.new.taskSystem") })}
          />
          <Field
            label={t("ui-app.new.taskContext")}
            value={context}
            onChange={setContext}
            multiline
            placeholder={t("ui-app.new.taskContextPlaceholder")}
          />
        </View>
      ) : null}
      <ErrorBox text={error} />
      <Button
        testID="create-session"
        disabled={
          !pid ||
          !workspacePath.trim() ||
          (requireTask && (!taskId.trim() || !taskTitle.trim()))
        }
        busy={busy}
        onPress={() => void create()}
      >
        {t("ui-app.new.create")}
      </Button>
    </Dialog>
  );
}
/** Whether a node reported this Agent's CLI; unknown capabilities allow it. */
function agentInstalled(
  node: { capabilities?: Record<string, unknown> } | undefined,
  agent: Agent,
) {
  const caps = node?.capabilities || {};
  if (!agents.some((a) => a in caps)) return true;
  return !!(caps[agent] as { installed?: boolean } | undefined)?.installed;
}
const NEW_SESSION_KEY = "daisy.newSession.v1";
interface NewSessionDefaults {
  agent?: Agent;
  /** Last identity per `${nodeId}:${agent}`. */
  profiles?: Record<string, string>;
}
function loadNewSessionDefaults(): NewSessionDefaults {
  if (Platform.OS !== "web") return {};
  try {
    const v = JSON.parse(readMigrated(window.localStorage, NEW_SESSION_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function saveNewSessionDefaults(v: NewSessionDefaults) {
  if (Platform.OS !== "web") return;
  try {
    window.localStorage.setItem(NEW_SESSION_KEY, JSON.stringify(v));
  } catch {
    /* private mode: this dialog only */
  }
}
export interface DaisyAppProps {
  client: DaisyClient;
  /** Shows 退出 when provided; also called on 401. Omit when the host owns login. */
  onLogout?: () => void;
  onToken?: (t: string) => void;
  initialTask?: TaskContext;
  /**
   * The host (gateway / SSO) owns the Daisy identity: hide password change
   * and treat 401 as an error instead of a logout.
   */
  hostAuth?: boolean;
  theme?: DaisyThemeInput | DaisyTheme;
  adapters?: DaisyHostAdapters;
  copy?: Partial<DaisyCopy>;
  /** Host product framing for the full workspace (from branding). */
  host?: DaisyAppHostOptions;
  /**
   * Controlled page: the host keeps it in its URL. When given, the
   * workspace shows this page and reports user navigation via
   * `onRouteChange` instead of only switching internally.
   */
  route?: DaisyAppRoute;
  onRouteChange?: (route: DaisyAppRoute) => void;
}
/** A page of the full workspace. */
export type DaisyAppRoute =
  | { page: "home" }
  | { page: "settings" }
  | { page: "chat"; sessionId: string };
/**
 * How the full workspace presents itself inside a host product (server
 * branding → `hostBrandingProps().host`). Presentation only.
 */
export interface DaisyAppHostOptions {
  /** Replaces the product name (PRODUCT_NAME) in the navigation header. */
  productName?: string;
  /** Line under the product name ("" hides it). */
  tagline?: string;
  /** Hide the marketing hero, English eyebrows, agent pitch cards and big display numbers. */
  hideMarketing?: boolean;
  /**
   * The host manages this machine (its faces, autostart, updates): 设置
   * shows only the PIN, identities and directories.
   */
  hideNodeSettings?: boolean;
  /** 「新的工作」: shown (default), hidden, or every new session must bind a task. */
  newWork?: "default" | "hidden" | "require-task";
  /** The embedding product as users know it, e.g. "the host UI". */
  hostName?: string;
  /**
   * 「← 返回 <hostName>」 target (top-level window only, not when framed);
   * followed only when same-origin or in DAISY_ORIGINS.
   */
  hostUrl?: string;
  /** @deprecated P1-08: no machine table any more; ignored. */
  nodesHint?: string;
  /** Hide developer integration notes; defaults to true with `hostAuth`. */
  hideDeveloperInfo?: boolean;
  /**
   * Host mode: link for a session's task when it has no `url`, with `{id}`
   * (e.g. "/tasks/{id}"); the task banner then opens it in the top window.
   */
  taskUrl?: string;
  /**
   * Rendered inside a host page that already has its own navigation and
   * user menu: no product header, no 「← 返回」, no user footer; the
   * workspace fills its container instead of the window.
   */
  embedded?: boolean;
  /** Host content at the top of 设置 (e.g. the host's own service switch). */
  settingsTop?: React.ReactNode;
  /** Host content at the bottom of 设置 (e.g. defaults for new chats). */
  settingsBottom?: React.ReactNode;
  /** @deprecated P1-08: no machine table any more; ignored. */
  nodeActions?: (node: NodeInfo) => React.ReactNode;
  /** Hide 工作目录 in 设置 (the host picks directories itself). */
  hideWorkspaces?: boolean;
  /**
   * Host panel beside the conversation on wide screens (e.g. the host's
   * related tasks); return null for none.
   */
  sessionAside?: (session: Session) => React.ReactNode;
}
/** Complete workspace (sessions, notifications, settings). */
export function DaisyApp({ theme, adapters, copy, ...props }: DaisyAppProps) {
  // P1-08: the PIN (state, banner, the dialog that trades it for a grant).
  let view = (
    <PinProvider client={props.client}>
      <AppView {...props} />
    </PinProvider>
  );
  if (adapters || copy)
    view = (
      <DaisyHostProvider adapters={adapters} copy={copy}>
        {view}
      </DaisyHostProvider>
    );
  return theme ? (
    <DaisyThemeProvider value={theme}>{view}</DaisyThemeProvider>
  ) : (
    view
  );
}
function AppView({
  client,
  onLogout,
  onToken,
  initialTask,
  hostAuth = false,
  host = {},
  route,
  onRouteChange,
}: Omit<DaisyAppProps, "theme" | "adapters" | "copy">) {
  // Signing out leaves nothing of this person's conversations behind.
  const logout = () => {
    clearSessionCache();
    client.forgetCached?.(); // kept ETag bodies too
    onLogout?.();
  };
  const t = useT();
  const copy = useDaisyCopy(),
    labels = copy.labels,
    when = useDaisyTime();
  const productName = host.productName || copy.productName,
    // The default tagline is the pack's (names.ts PRODUCT_TAGLINE is its Chinese form).
    tagline = host.tagline ?? t("ui-app.tagline"),
    marketing = !host.hideMarketing,
    canCreate = host.newWork !== "hidden",
    hideDeveloperInfo = host.hideDeveloperInfo ?? hostAuth;
  const focusScope = useDaisyFocusScope() as any;
  const { width } = useWindowDimensions(),
    compact = width < 800;
  const { C, s, rad, agents: colors } = useDaisyTheme();
  const embedded = !!host.embedded;
  // 「← 返回 <host>」: only in host mode, only as the top-level page (the host
  // already frames us otherwise), only to same-origin / DAISY_ORIGINS.
  const hostOrigins = useHostOrigins(client);
  const backHref =
    !embedded &&
    hostAuth &&
    host.hostUrl &&
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    window.top === window.self
      ? safeHostHref(host.hostUrl, window.location.href, hostOrigins)
      : null;
  // Task banner in host mode: task.url, else the branding template; opened
  // in the top window, same-origin / DAISY_ORIGINS only. A host adapter
  // (DaisyHostProvider / DaisyApp adapters) still wins.
  const { adapters: outer } = useDaisyHost();
  const taskAdapters = useMemo<DaisyHostAdapters | undefined>(
    () =>
      hostAuth && host.taskUrl && !outer.openTask && Platform.OS === "web"
        ? {
            openTask: (task) => {
              // task.url when it passes the origin check (a host may have
              // stored an absolute URL for another hostname), else the template.
              const here = window.location.href,
                href =
                  safeHostHref(task.url, here, hostOrigins) ||
                  safeHostHref(
                    host.taskUrl!.replace(
                      /\{id\}/g,
                      encodeURIComponent(task.id),
                    ),
                    here,
                    hostOrigins,
                  );
              if (href) window.open(href, "_top");
            },
          }
        : undefined,
    [hostAuth, host.taskUrl, outer.openTask, hostOrigins],
  );
  const backLink = backHref ? (
    <Pressable
      testID="host-back"
      accessibilityRole="link"
      accessibilityLabel={t("ui-app.nav.back", { host: host.hostName || t("ui-app.nav.backUp") })}
      onPress={() => window.location.assign(backHref)}
      style={{ paddingVertical: 4 }}
    >
      <Text style={{ fontSize: 12, color: C.accent, fontWeight: "600" }}>
        {t("ui-app.nav.backLink", { host: host.hostName || t("ui-app.nav.backUp") })}
      </Text>
    </Pressable>
  ) : null;
  const [catalog, setCatalog] = useState<Catalog>({
      nodes: [],
      profiles: [],
      workspaces: [],
    }),
    [sessions, setSessions] = useState<Session[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [create, setCreate] = useState(false),
    [page, setPage] = useState<"home" | "chat" | "settings">("home"),
    [error, setError] = useState(""),
    [search, setSearch] = useState(""),
    [user, setUser] = useState<User | null>(null),
    [mobileNav, setMobileNav] = useState(false),
    [archived, setArchived] = useState(false),
    [noticesOpen, setNoticesOpen] = useState(false),
    // P4-12 (5.10 工作台「待批准的调用」): call cards waiting for the owner.
    [callsOpen, setCallsOpen] = useState(false);
  const callCards = useCallRequestCount(client);
  // P1-08: 一轮结束 / 审批 / AI 出错 of the sessions (GET /api/notifications).
  const notices = useSessionNotifications(client);
  /**
   * Navigate: switch at once and tell a controlling host, which
   * keeps the page in its URL and feeds it back through `route`.
   */
  const go = (r: DaisyAppRoute) => {
    setPage(r.page);
    if (r.page === "chat") setSelected(r.sessionId);
    setMobileNav(false);
    onRouteChange?.(r);
  };
  // harness permission prompts are answered in 「审批」, not in
  // the conversation; a host with its own approvals page (the host UI) keeps it.
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const approvalsAdapter = useMemo<DaisyHostAdapters | undefined>(
    () =>
      outer.openApprovals
        ? {}
        : { openApprovals: () => setApprovalsOpen(true) },
    [outer.openApprovals],
  );
  const routeKey = route
    ? route.page === "chat"
      ? `chat:${route.sessionId}`
      : route.page
    : null;
  useEffect(() => {
    if (!route) return;
    setPage(route.page);
    if (route.page === "chat") setSelected(route.sessionId);
  }, [routeKey]);
  const refresh = async () => {
    try {
      const [c, ss, me] = await Promise.all([
        client.catalog(),
        client.sessions(),
        client.request<User>("/me"),
      ]);
      setUser(me);
      setCatalog(c);
      setSessions((previous) =>
        ss.map((next) => {
          const current = previous.find((x) => x.id === next.id);
          return current && current.updatedAt > next.updatedAt ? current : next;
        }),
      );
      setError("");
    } catch (e: any) {
      if (e.status === 401 && onLogout && !hostAuth) logout();
      else setError(e.message);
    }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 6000);
    return () => clearInterval(timer);
  }, [client]);
  const open = (id: string) => go({ page: "chat", sessionId: id });
  // The session list folds to a rail (<sidebarKeyPrefix>sessions, Ctrl/⌘+Shift+B).
  const [navCollapsed, toggleNav] = useSidebarCollapsed("sessions", !compact);
  const shown = sessions.filter(
      (x) =>
        x.archived === archived &&
        x.title.toLowerCase().includes(search.toLowerCase()),
    ),
    active = sessions.filter((x) =>
      ["queued", "running", "waiting"].includes(x.status),
    ),
    online = catalog.nodes.filter((n) => Date.now() - n.lastSeen < 30000);
  const rail = (
    <SidebarRail
      testID="daisy-rail"
      background={C.sidebar}
      items={shown.map((x) => ({
        id: x.id,
        agent: x.agent,
        title: x.title,
        selected: selected === x.id && page === "chat",
        statusColor:
          x.status === "running" ||
          x.status === "waiting" ||
          x.status === "queued"
            ? daisyPhaseColor(C, daisySessionPhase(x))
            : undefined,
      }))}
      onOpen={(item) => open(item.id)}
      onExpand={toggleNav}
      onCompose={canCreate ? () => setCreate(true) : undefined}
      composeLabel={t("ui-app.nav.newWork")}
    />
  );
  const nav = (
    <View
      testID="daisy-sidebar"
      style={{
        width: compact ? "100%" : 256,
        backgroundColor: C.sidebar,
        borderRightWidth: 1,
        borderColor: C.line,
        flex: compact ? 1 : undefined,
      }}
    >
      {compact ? null : (
        <View style={{ position: "absolute", top: 12, right: 10, zIndex: 1 }}>
          <SidebarToggle
            testID="daisy-sidebar-toggle"
            collapsed={false}
            onPress={toggleNav}
          />
        </View>
      )}
      {backLink && !compact ? (
        <View style={{ paddingHorizontal: 25, paddingTop: 18 }}>
          {backLink}
        </View>
      ) : null}
      {embedded ? (
        // Room for the fold toggle above 「新的工作」.
        <View style={{ height: compact ? 18 : 54 }} />
      ) : (
        <Pressable
          onPress={() => go({ page: "home" })}
          style={[s.row, { paddingHorizontal: 25, paddingVertical: 29 }]}
        >
          <Text style={{ fontSize: 29, color: C.accent }}>✳</Text>
          <View>
            <Text
              style={{
                fontSize: 16,
                fontWeight: "700",
                letterSpacing: marketing ? 0.4 : 0,
                color: C.ink,
              }}
            >
              {productName}
            </Text>
            {tagline ? (
              <Text
                style={{
                  fontSize: marketing ? 10 : 11,
                  color: C.muted,
                  letterSpacing: marketing ? 2 : 0,
                  marginTop: 3,
                }}
              >
                {tagline}
              </Text>
            ) : null}
          </View>
        </Pressable>
      )}
      <View style={{ paddingHorizontal: 18, gap: 18 }}>
        {canCreate ? (
          <Button
            testID="new-session"
            onPress={() => {
              setCreate(true);
              setMobileNav(false);
            }}
          >
            {t("ui-app.nav.newWorkButton")}
          </Button>
        ) : null}
        <View style={{ gap: 4 }}>
          <Button
            variant={page === "home" ? "soft" : "ghost"}
            onPress={() => go({ page: "home" })}
            style={{ alignItems: "flex-start" }}
          >
            {t("ui-app.nav.overview")}
          </Button>
          <Button
            variant={page === "settings" ? "soft" : "ghost"}
            onPress={() => go({ page: "settings" })}
            style={{ alignItems: "flex-start" }}
          >
            {t("ui-app.nav.settings")}
          </Button>
          <NotificationsButton
            n={notices}
            onPress={() => {
              setNoticesOpen(true);
              setMobileNav(false);
            }}
          />
          {callCards ? (
            <Button
              variant="ghost"
              testID="nav-call-requests"
              onPress={() => {
                setCallsOpen(true);
                setMobileNav(false);
              }}
              style={{ alignItems: "flex-start" }}
            >
              {t("ui-app.nav.calls", { count: callCards })}
            </Button>
          ) : null}
        </View>
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <Text
            style={{
              fontSize: marketing ? 10 : 11,
              fontWeight: "600",
              letterSpacing: marketing ? 1.5 : 0,
              color: C.muted,
            }}
          >
            {archived ? t("ui-app.nav.archived") : t("ui-app.nav.recent")}
          </Text>
          <Pressable onPress={() => setArchived(!archived)}>
            <Text style={{ fontSize: 11, color: C.muted }}>
              {archived ? t("ui-app.nav.unarchive") : t("ui-app.nav.archive")}
            </Text>
          </Pressable>
        </View>
        <Field
          label={t("ui-app.nav.search")}
          value={search}
          onChange={setSearch}
          placeholder={t("ui-app.nav.searchPlaceholder")}
        />
      </View>
      <ScrollView
        style={{ flex: 1, marginTop: 10 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 20 }}
      >
        {shown.map((session) => (
          <Pressable
            key={session.id}
            onPress={() => open(session.id)}
            style={({ pressed }) => ({
              paddingHorizontal: 14,
              paddingVertical: 13,
              borderRadius: rad(10),
              backgroundColor:
                selected === session.id && page === "chat"
                  ? C.sidebarSelected
                  : pressed
                    ? C.sidebarPressed
                    : "transparent",
              marginVertical: 2,
              gap: 6,
            })}
          >
            <View style={s.row}>
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor:
                    session.status === "running"
                      ? C.accent
                      : colors[session.agent],
                }}
              />
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 12,
                  color: C.ink,
                  flex: 1,
                  fontWeight: selected === session.id ? "600" : "400",
                }}
              >
                {session.title}
              </Text>
            </View>
            <Text style={{ fontSize: 10, color: C.muted, marginLeft: 16 }}>
              {labels[session.agent]} ·{" "}
              <Text
                style={{
                  fontSize: 10,
                  color: daisyPhaseColor(C, daisySessionPhase(session)),
                }}
              >
                {labels[phaseLabelKey[daisySessionPhase(session)]]}
              </Text>
              <SessionMark items={notices.bySession.get(session.id)} />
              {session.live?.online ? (
                <Text
                  testID="session-online"
                  style={{ fontSize: 10, color: C.green }}
                >
                  {t("ui-app.nav.online", {
                    background: backgroundCount(session)
                      ? t("ui-app.nav.background", { count: backgroundCount(session) })
                      : "",
                  })}
                </Text>
              ) : null}
            </Text>
          </Pressable>
        ))}
        {!shown.length ? (
          <Text style={[s.muted, { padding: 18, fontSize: 12 }]}>
            {canCreate ? t("ui-app.nav.emptyCreate") : t("ui-app.nav.empty")}
          </Text>
        ) : null}
      </ScrollView>
      {embedded ? null : (
        <View style={{ padding: 20, borderTopWidth: 1, borderColor: C.line }}>
          <View style={s.row}>
            <View
              style={{
                width: 30,
                height: 30,
                borderRadius: rad(10),
                backgroundColor: C.avatar,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: C.accent, fontWeight: "700" }}>
                {user?.username.slice(0, 1).toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 12, color: C.ink, fontWeight: "600" }}>
                {user?.username || t("ui-app.nav.workspace")}
              </Text>
              <Text style={{ fontSize: 10, color: C.muted, marginTop: 3 }}>
                {online.length ? t("ui-app.nav.aiOnline") : t("ui-app.nav.aiNotReady")}
              </Text>
              <PinHistoryLine />
            </View>
            {onLogout ? (
              <Button variant="ghost" onPress={logout}>
                {t("ui-app.nav.logout")}
              </Button>
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
  const shell = (
    <SafeAreaView {...focusScope} style={{ flex: 1, backgroundColor: C.paper }}>
      <View style={{ flex: 1, flexDirection: "row" }}>
        {!compact ? (navCollapsed ? rail : nav) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <PinBanner onSet={() => go({ page: "settings" })} />
          {compact ? (
            <View
              style={[
                s.row,
                {
                  paddingHorizontal: 15,
                  paddingVertical: 9,
                  borderBottomWidth: 1,
                  borderColor: C.line,
                },
              ]}
            >
              <Button variant="ghost" testID="mobile-nav-open" onPress={() => setMobileNav(true)}>
                ☰
              </Button>
              {backLink}
              <Text style={{ flex: 1, color: C.ink, fontWeight: "600" }}>
                {marketing ? `✳ ${productName}` : productName}
              </Text>
              {canCreate ? (
                <Button variant="soft" onPress={() => setCreate(true)}>
                  {t("ui-app.nav.newShort")}
                </Button>
              ) : null}
            </View>
          ) : null}
          {page === "chat" && selected ? (
            <DaisySessionView
              client={client}
              sessionId={selected}
              session={sessions.find((x) => x.id === selected)}
              adapters={taskAdapters}
              aside={(() => {
                if (!host.sessionAside || compact || width < 1400) return null;
                const current = sessions.find((x) => x.id === selected);
                return current ? host.sessionAside(current) : null;
              })()}
              onNavigate={(id) => {
                go({ page: "chat", sessionId: id });
                void refresh();
              }}
              onSessionChange={(session) =>
                setSessions((current) =>
                  current.map((s) => (s.id === session.id ? session : s)),
                )
              }
              onArchiveChanged={() => {
                void refresh();
                go({ page: "home" });
              }}
              onDeleted={(id) => {
                setSessions((cur) => cur.filter((x) => x.id !== id));
                go({ page: "home" });
                void refresh();
              }}
              onError={setError}
            />
          ) : page === "settings" ? (
            <Settings
              client={client}
              catalog={catalog}
              user={user}
              hideNodeSettings={!!host.hideNodeSettings}
              hideDeveloperInfo={hideDeveloperInfo}
              hostName={host.hostName}
              onRefresh={refresh}
              top={host.settingsTop}
              bottom={host.settingsBottom}
              hideWorkspaces={!!host.hideWorkspaces}
            />
          ) : (
            <ScrollView
              contentContainerStyle={{
                padding: compact ? 23 : 44,
                gap: 30,
                maxWidth: 1250,
                width: "100%",
                alignSelf: "center",
              }}
            >
              <View style={[s.row, { justifyContent: "space-between" }]}>
                {marketing ? (
                  <Text
                    style={{ fontSize: 11, color: C.muted, letterSpacing: 1.2 }}
                  >
                    WORKSPACE / OVERVIEW
                  </Text>
                ) : (
                  <Text style={[s.h3, { fontSize: 18 }]}>{t("ui-app.home.overview")}</Text>
                )}
                <Badge
                  text={online.length ? t("ui-app.nav.aiOnline") : t("ui-app.nav.aiNotReady")}
                  color={online.length ? C.accent : C.orange}
                />
              </View>
              {marketing ? (
                <View style={{ gap: 10 }}>
                  <Text style={[s.title, { fontSize: compact ? 28 : 34 }]}>
                    {t("ui-app.home.headline")}
                  </Text>
                  <Text style={[s.muted, { fontSize: 14 }]}>
                    {t("ui-app.home.tagline")}
                  </Text>
                </View>
              ) : null}
              <ErrorBox text={error} />
              <View
                style={{ flexDirection: compact ? "column" : "row", gap: 16 }}
              >
                {[
                  {
                    label: t("ui-app.home.active"),
                    value: active.length,
                    caption: t("ui-app.home.activeCaption"),
                  },
                  {
                    label: t("ui-app.home.waiting"),
                    value: [...notices.bySession.values()]
                      .flat()
                      .filter(
                        (n) => n.category === "approval" && n.state === "pending",
                      ).length,
                    caption: t("ui-app.home.waitingCaption"),
                  },
                  {
                    label: t("ui-app.home.sessions"),
                    value: sessions.filter((x) => !x.archived).length,
                    caption: copy.approvalRecords,
                  },
                ].map((x) => (
                  <View
                    key={x.label}
                    style={[s.card, { flex: 1, padding: 22 }]}
                  >
                    <Text style={s.muted}>{x.label}</Text>
                    <Text
                      style={{
                        fontSize: marketing ? 32 : 22,
                        fontWeight: "600",
                        color: C.ink,
                      }}
                    >
                      {marketing
                        ? x.value.toString().padStart(2, "0")
                        : String(x.value)}
                    </Text>
                    <Text style={{ fontSize: 11, color: C.muted }}>
                      {x.caption}
                    </Text>
                  </View>
                ))}
              </View>
              {marketing ? (
                <View style={{ gap: 18 }}>
                  <View style={s.row}>
                    <Text style={[s.h3, { flex: 1 }]}>{t("ui-app.home.pickAgent")}</Text>
                    <Text style={{ fontSize: 11, color: C.muted }}>
                      {t("ui-app.home.agentCount", { count: agents.length })}
                    </Text>
                  </View>
                  <View
                    style={{
                      flexDirection: compact ? "column" : "row",
                      // P4-10: more than three agents wrap to the next row.
                      flexWrap: compact ? "nowrap" : "wrap",
                      gap: 16,
                    }}
                  >
                    {agents.map((a) => (
                      <Pressable
                        key={a}
                        disabled={!canCreate}
                        onPress={() => setCreate(true)}
                        style={[
                          s.card,
                          { flex: 1, minWidth: 240, padding: 22, gap: 17 },
                        ]}
                      >
                        <View style={s.row}>
                          <View
                            style={{
                              width: 38,
                              height: 38,
                              borderRadius: rad(11),
                              backgroundColor: withAlpha(colors[a], "16"),
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <Text
                              style={{
                                fontSize: 22,
                                fontWeight: "600",
                                color: colors[a],
                              }}
                            >
                              {agentLetter(a)}
                            </Text>
                          </View>
                          <Text style={[s.h3, { flex: 1 }]}>{labels[a]}</Text>
                          <Text style={{ color: C.muted }}>↗</Text>
                        </View>
                        <Text
                          style={[s.muted, { fontSize: 12, minHeight: 42 }]}
                        >
                          {a === "claude"
                            ? t("ui-app.home.claudeBlurb")
                            : a === "codex"
                              ? t("ui-app.home.codexBlurb")
                              : harnessText(acpHarness(a) ?? { name: a }, "description", t)}
                        </Text>
                        <View style={s.row}>
                          <Badge
                            text={
                              catalog.profiles.some((p) => p.agent === a)
                                ? t("ui-app.home.hasProfile")
                                : t("ui-app.home.noProfile")
                            }
                            color={colors[a]}
                          />
                          <Text style={{ fontSize: 10, color: C.muted }}>
                            {a === "claude"
                              ? t("ui-app.home.claudeAuth")
                              : a === "codex"
                                ? t("ui-app.home.codexAuth")
                                : t("ui-app.home.cliAuth")}
                          </Text>
                        </View>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : null}
              <View style={{ gap: 16 }}>
                <View style={s.row}>
                  <Text style={[s.h3, { flex: 1 }]}>{t("ui-app.home.recent")}</Text>
                  {canCreate ? (
                    <Button variant="outline" onPress={() => setCreate(true)}>
                      {t("ui-app.home.newSession")}
                    </Button>
                  ) : null}
                </View>
                {sessions
                  .filter((x) => !x.archived)
                  .slice(0, 6)
                  .map((ss) => (
                    <Pressable
                      key={ss.id}
                      onPress={() => open(ss.id)}
                      style={[
                        s.row,
                        {
                          backgroundColor: C.paper,
                          borderWidth: 1,
                          borderColor: C.line,
                          padding: 18,
                          borderRadius: rad(11),
                        },
                      ]}
                    >
                      <View
                        style={{
                          width: 33,
                          height: 33,
                          borderRadius: rad(9),
                          backgroundColor: withAlpha(colors[ss.agent], "15"),
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text style={{ color: colors[ss.agent] }}>◈</Text>
                      </View>
                      <View style={{ flex: 1, gap: 5 }}>
                        <Text
                          style={{
                            color: C.ink,
                            fontSize: 13,
                            fontWeight: "500",
                          }}
                        >
                          {ss.title}
                        </Text>
                        <Text style={{ color: C.muted, fontSize: 10 }}>
                          {labels[ss.agent]} · {when.date(ss.updatedAt)}{" "}
                          {when.time(ss.updatedAt)}
                        </Text>
                      </View>
                      <Badge
                        text={labels[phaseLabelKey[daisySessionPhase(ss)]]}
                        color={daisyPhaseColor(C, daisySessionPhase(ss))}
                      />
                      <Text style={{ color: C.muted }}>→</Text>
                    </Pressable>
                  ))}
                {!sessions.some((x) => !x.archived) ? (
                  <View
                    style={[
                      s.card,
                      {
                        borderStyle: "dashed",
                        backgroundColor: "transparent",
                        alignItems: "center",
                        padding: 35,
                      },
                    ]}
                  >
                    <Text style={{ fontSize: 13, color: C.muted }}>
                      {marketing
                        ? t("ui-app.home.firstTask")
                        : t("ui-app.home.empty")}
                    </Text>
                    {canCreate ? (
                      <Button variant="soft" onPress={() => setCreate(true)}>
                        {t("ui-app.home.start")}
                      </Button>
                    ) : null}
                  </View>
                ) : null}
              </View>
              {marketing ? (
                <View
                  style={[
                    s.row,
                    { borderTopWidth: 1, borderColor: C.line, paddingTop: 19 },
                  ]}
                >
                  <Text style={{ fontSize: 10, color: C.muted, flex: 1 }}>
                    {t("ui-app.home.footer", { name: productName.toUpperCase() })}
                  </Text>
                  <Text style={{ fontSize: 10, color: C.muted }}>v0.1.0</Text>
                </View>
              ) : null}
            </ScrollView>
          )}
        </View>
      </View>
      {create && canCreate ? (
        <DaisyNewSession
          client={client}
          catalog={catalog}
          task={initialTask}
          requireTask={host.newWork === "require-task"}
          hostName={host.hostName}
          me={user}
          onCatalogChanged={refresh}
          onClose={() => setCreate(false)}
          onCreated={(ss) => {
            setCreate(false);
            void refresh();
            open(ss.id);
          }}
        />
      ) : null}
      {compact && mobileNav ? (
        <Modal
          visible
          animationType="slide"
          onRequestClose={() => setMobileNav(false)}
        >
          <SafeAreaView style={{ flex: 1 }}>
            <Button variant="ghost" onPress={() => setMobileNav(false)}>
              {t("ui-app.nav.closeNav")}
            </Button>
            {nav}
          </SafeAreaView>
        </Modal>
      ) : null}
      {noticesOpen ? (
        <Modal
          visible
          animationType="slide"
          onRequestClose={() => setNoticesOpen(false)}
        >
          <SafeAreaView style={{ flex: 1 }}>
            <NotificationList
              n={notices}
              onClose={() => setNoticesOpen(false)}
              onOpenSession={(id) => {
                setNoticesOpen(false);
                open(id);
              }}
            />
          </SafeAreaView>
        </Modal>
      ) : null}
      {callsOpen ? (
        <Modal visible animationType="slide" onRequestClose={() => setCallsOpen(false)}>
          <SafeAreaView style={{ flex: 1 }}>
            <View testID="call-requests-panel" style={{ flex: 1, padding: 16, gap: 12 }}>
              <View style={[s.row, { justifyContent: "space-between" }]}>
                <Text style={{ fontSize: 18, fontWeight: "600", color: C.ink }}>{t("ui-app.calls.title")}</Text>
                <Button variant="ghost" onPress={() => setCallsOpen(false)}>
                  {t("ui-app.close")}
                </Button>
              </View>
              <ScrollView contentContainerStyle={{ gap: 12 }}>
                <CallRequestList client={client} />
              </ScrollView>
            </View>
          </SafeAreaView>
        </Modal>
      ) : null}
      {approvalsOpen ? (
        <Modal
          visible
          animationType="slide"
          onRequestClose={() => setApprovalsOpen(false)}
        >
          <SafeAreaView style={{ flex: 1 }}>
            <View
              testID="approvals-panel"
              style={{ flex: 1, padding: 16, gap: 12 }}
            >
              <View style={[s.row, { justifyContent: "space-between" }]}>
                <Text style={{ fontSize: 18, fontWeight: "600", color: C.ink }}>
                  {t("ui-app.approvals.title")}
                </Text>
                <Button variant="ghost" onPress={() => setApprovalsOpen(false)}>
                  {t("ui-app.close")}
                </Button>
              </View>
              <ScrollView contentContainerStyle={{ gap: 12 }}>
                <DaisyApprovalList
                  client={client}
                  empty={<Text style={s.muted}>{t("ui-app.approvals.empty")}</Text>}
                />
              </ScrollView>
            </View>
          </SafeAreaView>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
  return (
    <DaisyHostProvider adapters={approvalsAdapter}>{shell}</DaisyHostProvider>
  );
}
