import { AGENT_IDS, managedLoginSupported, shownName } from "@daisy-ai/contracts";
import { Text } from "./primitives";
import React, { useEffect, useState, useRef } from "react";
import { View } from "react-native";
import type { DaisyClient, Catalog } from "@daisy-ai/client";
import type { Agent } from "@daisy-ai/contracts";
import { Button, Field, Badge, ErrorBox } from "./primitives";
import {
  DaisyHostProvider,
  useDaisyCopy,
  useOpenUrl,
  type DaisyCopy,
  type DaisyHostAdapters,
} from "./host";
import { t as ut, useT } from "./i18n";
import {
  DaisyThemeProvider,
  useDaisyTheme,
  type DaisyTheme,
  type DaisyThemeInput,
} from "./theme";
/**
 * Delete an identity: two steps, focus-safe. Any
 * unfinished login is cancelled by the server; a turn still running refuses.
 */
export function DeleteIdentity({
  client,
  profileId,
  managed,
  onDeleted,
}: {
  client: DaisyClient;
  profileId: string;
  managed: boolean;
  onDeleted: () => Promise<unknown> | void;
}) {
  const { s } = useDaisyTheme();
  const t = useT();
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!confirm)
    return (
      <Button
        variant="ghost"
        testID={`identity-delete-${profileId}`}
        onPress={() => {
          setError("");
          setConfirm(true);
        }}
      >
        {t("ui-login.delete.button")}
      </Button>
    );
  return (
    <View style={{ gap: 8 }} testID={`identity-delete-confirm-${profileId}`}>
      <Text style={s.muted}>
        {managed ? t("ui-login.delete.managed") : t("ui-login.delete.other")}
      </Text>
      <View style={[s.row, { flexWrap: "wrap" }]}>
        <Button
          variant="danger"
          busy={busy}
          testID={`identity-delete-yes-${profileId}`}
          onPress={() =>
            void (async () => {
              setBusy(true);
              setError("");
              try {
                await client.request(`/profiles/${profileId}`, "DELETE");
                await onDeleted();
              } catch (e: any) {
                setError(e.message);
                setBusy(false);
              }
            })()
          }
        >
          {t("ui-login.delete.confirm")}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onPress={() => setConfirm(false)}
        >
          {t("ui-login.cancel")}
        </Button>
      </View>
      <ErrorBox text={error} />
    </View>
  );
}

export interface DaisyAgentLoginProps {
  client: DaisyClient;
  /**
   * Nodes and identities to show. Omit to let the component load
   * `client.catalog()` itself (and reload it after each login step).
   */
  catalog?: Catalog;
  /** Called after a login step changed identities (reload your catalog here). */
  onRefresh?: () => Promise<void> | void;
  /**
   * Fix the execution node (e.g. the member's own runner in a host settings
   * page): hides the node picker and lists only that node's identities.
   */
  nodeId?: string;
  /** Hide the node picker; the first online usable node is used. */
  hideNodePicker?: boolean;
  /** Agents offered for login (default: all three). */
  agents?: Agent[];
  /** Theme / wording / link adapter, merged over enclosing providers (as DaisyChat). */
  theme?: DaisyThemeInput | DaisyTheme;
  copy?: Partial<DaisyCopy>;
  adapters?: DaisyHostAdapters;
}
/** Host-facing login card: AgentLogin with optional theme / copy / adapters. */
export function DaisyAgentLogin({
  theme,
  copy,
  adapters,
  ...props
}: DaisyAgentLoginProps) {
  let view = <AgentLogin {...props} />;
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
/** Usable node to log in on: online and unblocked first, else the first one. */
/** A login job is in flight (official page / device code / auth code). */
export const loginActive = (j?: { status?: string } | null) =>
  !!j && ["queued", "running", "waiting"].includes(j.status || "");

/**
 * One identity's sign-in state for badges and chips. `tone` drives colour:
 * ok (usable), wait (needs the user), bad (failed), idle (not signed in).
 */
export function loginStatus(
  j: { status?: string } | null | undefined,
  p: { configDir?: string; authMode?: string; lastAuthenticatedAt?: number },
  queued?: string,
): { text: string; tone: "ok" | "wait" | "bad" | "idle" } {
  if (p.authMode === "apiKey") return { text: ut("ui-login.status.apiKey"), tone: "ok" };
  if (!p.configDir?.startsWith("managed:"))
    return { text: p.configDir ? ut("ui-login.status.cliDir") : ut("ui-login.status.host"), tone: "ok" };
  switch (j?.status) {
    case "queued":
      return { text: queued ?? ut("ui-login.status.queued"), tone: "wait" };
    case "running":
      return { text: ut("ui-login.status.running"), tone: "wait" };
    case "waiting":
      return { text: ut("ui-login.status.waiting"), tone: "wait" };
    case "complete":
      return { text: ut("ui-login.status.done"), tone: "ok" };
    case "error":
      return { text: ut("ui-login.status.failed"), tone: "bad" };
    case "expired":
      return { text: ut("ui-login.status.expired"), tone: "bad" };
  }
  return p.lastAuthenticatedAt
    ? { text: ut("ui-login.status.done"), tone: "ok" }
    : {
        text: j?.status === "cancelled" ? ut("ui-login.status.cancelled") : ut("ui-login.status.notSignedIn"),
        tone: "idle",
      };
}

/**
 * The official sign-in steps of one managed identity: the official page,
 * device code, auth-code input, and 取消登录 / 开始登录 / 重新授权. Shared by
 * the login panel and the settings node table.
 */
export function LoginSteps({
  client,
  profileId,
  job: j,
  busy,
  act,
  onError,
}: {
  client: DaisyClient;
  profileId: string;
  job?: any;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const { C, s, rad, sp } = useDaisyTheme();
  const t = useT();
  const openUrl = useOpenUrl();
  const [code, setCode] = useState("");
  const active = loginActive(j);
  return (
    <View style={{ gap: 10 }}>
      {j?.message ? <Text style={s.muted}>{j.message}</Text> : null}
      {active && j.url ? (
        <>
          <Button
            onPress={() => void openUrl(j.url).catch((e) => onError(e.message))}
          >
            {t("ui-login.steps.open")}
          </Button>
          <Text selectable style={[s.mono, { fontSize: 10 }]}>
            {j.url}
          </Text>
        </>
      ) : null}
      {active && j.userCode ? (
        <View
          style={{
            backgroundColor: C.soft,
            padding: sp(16),
            borderRadius: rad(12),
          }}
        >
          <Text style={s.label}>{t("ui-login.steps.deviceCode")}</Text>
          <Text
            selectable
            style={{
              fontSize: 28,
              letterSpacing: 4,
              color: C.accent,
              fontWeight: "700",
            }}
          >
            {j.userCode}
          </Text>
        </View>
      ) : null}
      {active && j.needsInput ? (
        <>
          <Field
            label={t("ui-login.steps.authCode")}
            secret
            value={code}
            onChange={setCode}
            placeholder={t("ui-login.steps.authCodePlaceholder")}
          />
          <Button
            busy={busy}
            disabled={!code}
            onPress={() =>
              void act(async () => {
                await client.request(`/logins/${j.id}/input`, "POST", {
                  code: code.trim(),
                });
                setCode("");
              })
            }
          >
            {t("ui-login.steps.submit")}
          </Button>
        </>
      ) : null}
      <View style={s.row}>
        {active ? (
          <Button
            variant="ghost"
            onPress={() =>
              void act(() =>
                client.request(`/logins/${j.id}/cancel`, "POST", {}),
              )
            }
          >
            {t("ui-login.steps.cancel")}
          </Button>
        ) : (
          <Button
            busy={busy}
            variant="soft"
            testID={`identity-login-${profileId}`}
            onPress={() =>
              void act(() =>
                client.request(`/profiles/${profileId}/login`, "POST", {}),
              )
            }
          >
            {j?.status === "complete" ? t("ui-login.steps.again") : t("ui-login.steps.start")}
          </Button>
        )}
      </View>
    </View>
  );
}

function defaultNode(catalog: Catalog | null) {
  const nodes = catalog?.nodes || [];
  return (
    nodes.find((n) => n.online !== false)?.id ||
    nodes[0]?.id ||
    ""
  );
}
/**
 * Official subscription login for managed identities (Daisy settings; also
 * exported as `DaisyAgentLogin` for a host settings page).
 */
export function AgentLogin({
  client,
  catalog: hostCatalog,
  onRefresh: hostRefresh,
  nodeId: fixedNode,
  hideNodePicker,
  // P4-10: those that can log in here (an ACP harness with a login entry).
  agents = (AGENT_IDS as Agent[]).filter(managedLoginSupported),
}: Omit<DaisyAgentLoginProps, "theme" | "copy" | "adapters">) {
  const [ownCatalog, setOwnCatalog] = useState<Catalog | null>(null);
  const catalog = hostCatalog || ownCatalog;
  const [jobs, setJobs] = useState<any[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [pickedNode, setNodeId] = useState("");
  const nodeId = fixedNode || pickedNode || defaultNode(catalog);
  const showPicker =
    !fixedNode && !hideNodePicker && (catalog?.nodes.length || 0) > 0;
  const { C, s } = useDaisyTheme();
  const t = useT();
  const copy = useDaisyCopy(),
    { labels } = copy;
  useEffect(() => {
    if (hostCatalog) return;
    let alive = true;
    void client
      .catalog()
      .then((c) => alive && setOwnCatalog(c))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [client, hostCatalog]);
  const onRefresh = async () => {
    if (!hostCatalog) setOwnCatalog(await client.catalog());
    await hostRefresh?.();
  };
  const refreshed = useRef(new Set<string>());
  useEffect(() => {
    for (const j of jobs)
      if (j.status === "complete" && !refreshed.current.has(j.id)) {
        refreshed.current.add(j.id);
        void onRefresh().catch((e) => setError(e.message));
      }
  }, [jobs]);
  const reload = async () => setJobs(await client.request("/logins"));
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await client.request("/logins");
        if (alive) setJobs(r);
      } catch (e: any) {
        if (alive) setError(e.message);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client]);
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
      await reload();
      await onRefresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[s.card, { gap: 16 }]} testID="agent-login">
      <Text style={s.h3}>{copy.loginTitle}</Text>
      <Text style={s.muted}>{copy.loginBody}</Text>
      {showPicker ? (
        <View style={[s.row, { flexWrap: "wrap" }]}>
          {catalog!.nodes.map((n) => (
            <Button
              key={n.id}
              variant={nodeId === n.id ? "primary" : "soft"}
              onPress={() => setNodeId(n.id)}
            >
              {shownName("node", n, t)}
            </Button>
          ))}
        </View>
      ) : null}
      {catalog && !nodeId ? (
        <Text testID="agent-login-no-node" style={s.muted}>
          {copy.loginNoNode}
        </Text>
      ) : null}
      <View style={[s.row, { flexWrap: "wrap" }]}>
        {agents.map((agent) => (
          <Button
            key={agent}
            testID={`login-${agent}`}
            disabled={!nodeId}
            busy={busy}
            variant="soft"
            onPress={() =>
              void act(async () => {
                const p = await client.request("/identities", "POST", {
                  nodeId,
                  agent,
                  label: t("ui-identities.ownAccountLabel", {
                    harness: labels[agent] ?? agent,
                    date: new Date().toLocaleDateString(t.lang),
                  }),
                });
                await client.request(`/profiles/${p.id}/login`, "POST", {});
              })
            }
          >
            {t("ui-login.signIn", { harness: labels[agent] ?? agent })}
          </Button>
        ))}
      </View>
      <ErrorBox text={error} />
      {(catalog?.profiles || [])
        .filter(
          (p) =>
            p.configDir.startsWith("managed:") &&
            (!fixedNode || p.nodeId === fixedNode),
        )
        .map((p) => {
          const j = jobs.find((x) => x.profileId === p.id);
          return (
            <View
              key={p.id}
              style={{
                borderTopWidth: 1,
                borderColor: C.line,
                paddingTop: 14,
                gap: 10,
              }}
            >
              <View style={[s.row, { flexWrap: "wrap" }]}>
                <Text style={[s.label, { flex: 1 }]}>{shownName("profile", p, t)}</Text>
                <Badge
                  text={loginStatus(j, p, copy.loginQueued).text}
                  color={loginStatus(j, p).tone === "bad" ? C.red : C.accent}
                />
              </View>
              <LoginSteps
                client={client}
                profileId={p.id}
                job={j}
                busy={busy}
                act={act}
                onError={setError}
              />
              <DeleteIdentity
                client={client}
                profileId={p.id}
                managed
                onDeleted={async () => {
                  await reload();
                  await onRefresh();
                }}
              />
            </View>
          );
        })}
    </View>
  );
}
