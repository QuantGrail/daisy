/**
 * P1-08: 设置 — 工作目录, 自启动, 更新 (5.10's 「设置」 for stage 1).
 *
 * - 工作目录: the registered directories (catalog), and registering one
 *   (POST /api/workspaces via the picker; browsing is POST
 *   /api/nodes/:id/filesystem — off on the outside face unless allowed).
 * - 开机自启: GET / PUT /api/autostart (P1-09; `daisy autostart` shares its
 *   logic); `supported: false` shows the reason.
 * - 更新: `daisy restart …` (GET /api/update, POST / DELETE
 *   /api/update/restart) and this Daisy's auto-update state (D-34).
 */
import { shownName } from "@daisy-ai/contracts";
import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import {
  DaisyError,
  type AutostartView,
  type Catalog,
  type DaisyClient,
} from "@daisy-ai/client";
import { Badge, Button, ErrorBox, Text } from "./primitives";
import { useDaisyTheme } from "./theme";
import { useDaisyTime } from "./host";
import { WorkspacePicker } from "./workspace";
import { autoUpdateLine } from "./settings-view";
import { useT } from "./i18n";

export function WorkspaceSettings({
  client,
  catalog,
  onRefresh,
}: {
  client: DaisyClient;
  catalog: Catalog;
  onRefresh: () => Promise<void>;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const node = catalog.nodes[0];
  const home = String((node?.capabilities?.filesystem as any)?.home || "~");
  const [path, setPath] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [added, setAdded] = useState("");
  const ws = catalog.workspaces.filter((w) => !node || w.nodeId === node.id);
  return (
    <View style={[s.card, { gap: 12 }]} testID="settings-workspaces">
      <View style={{ gap: 4 }}>
        <Text style={s.h3}>{t("ui-settings.workspaces.title")}</Text>
        <Text style={[s.muted, { fontSize: 12 }]}>
          {t("ui-settings.workspaces.intro")}
        </Text>
      </View>
      {ws.length ? (
        <View style={{ gap: 4 }} testID="workspace-list">
          {ws.map((w) => (
            <View key={w.id} style={[s.row, { flexWrap: "wrap" }]}>
              <Text style={{ fontSize: 13, color: C.ink, fontWeight: "500" }}>
                {shownName("workspace", w, t)}
              </Text>
              <Text selectable style={[s.mono, { fontSize: 12, color: C.muted, flex: 1 }]}>
                {w.path}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={{ fontSize: 13, color: C.faint }}>{t("ui-settings.workspaces.empty")}</Text>
      )}
      {node ? (
        <View style={{ gap: 8, maxWidth: 640 }}>
          <WorkspacePicker
            client={client}
            nodeId={node.id}
            nodeLabel={shownName("node", node, t)}
            path={path || home}
            onChange={setPath}
            recent={ws}
            disabled={busy}
          />
          <View style={s.row}>
            <Button
              variant="outline"
              testID="workspace-register"
              busy={busy}
              disabled={!(path || home).trim()}
              onPress={() =>
                void (async () => {
                  setBusy(true);
                  setError("");
                  setAdded("");
                  try {
                    const w = await client.ensureWorkspace(node.id, (path || home).trim());
                    setAdded(w.path);
                    await onRefresh();
                  } catch (e: any) {
                    setError(e.message);
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              {t("ui-settings.workspaces.register")}
            </Button>
            {added ? (
              <Text style={{ fontSize: 12, color: C.green, flex: 1 }}>{t("ui-settings.workspaces.registered", { path: added })}</Text>
            ) : null}
          </View>
        </View>
      ) : null}
      <ErrorBox text={error} />
    </View>
  );
}

/**
 * 开机自启 (P1-09's GET / PUT /api/autostart, `daisy:manage`, no PIN). Where
 * the system has none yet (`supported: false`), its reason is shown.
 */
export function AutostartSettings({ client }: { client: DaisyClient }) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const [st, setSt] = useState<AutostartView | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    void client
      .autostart()
      .then(setSt)
      .catch((e) => setError(e.message));
  }, [client]);
  const set = async (enabled: boolean) => {
    setBusy(true);
    setError("");
    try {
      setSt(await client.setAutostart(enabled));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[s.card, { gap: 8 }]} testID="settings-autostart">
      <View style={[s.row, { flexWrap: "wrap" }]}>
        <Text style={[s.h3, { flex: 1 }]}>{t("ui-settings.autostart.title")}</Text>
        {st?.supported ? (
          <Badge
            text={st.enabled ? t("ui-settings.autostart.on") : t("ui-settings.autostart.off")}
            color={st.enabled ? C.green : C.muted}
          />
        ) : null}
      </View>
      {!st ? (
        error ? null : <Text style={s.muted}>{t("ui.common.loading")}</Text>
      ) : st.supported ? (
        <>
          <Text style={[s.muted, { fontSize: 12 }]} testID="autostart-detail">
            {st.manager === "systemd-user"
              ? st.unit
                ? t("ui-settings.autostart.systemdUnit", { unit: st.unit })
                : t("ui-settings.autostart.systemd")
              : st.manager === "launchd"
                ? st.unit
                  ? t("ui-settings.autostart.launchdUnit", { unit: st.unit })
                  : t("ui-settings.autostart.launchd")
                : st.manager === "windows-run"
                  ? t("ui-settings.autostart.windows", { unit: st.unit ?? "" })
                  : st.manager
                  ? t("ui-settings.autostart.other", { manager: st.manager })
                  : ""}
            {t("ui-settings.autostart.note")}
          </Text>
          {st.linger === false ? (
            <Text style={{ fontSize: 12, color: C.orange }}>
              {t("ui-settings.autostart.noLinger")}
            </Text>
          ) : null}
          {st.hint ? (
            <Text selectable style={[s.muted, { fontSize: 12 }]} testID="autostart-hint">
              {st.hint}
            </Text>
          ) : null}
          <View style={s.row}>
            <Button
              testID="autostart-toggle"
              variant={st.enabled ? "outline" : "primary"}
              busy={busy}
              onPress={() => void set(!st.enabled)}
            >
              {st.enabled ? t("ui-settings.autostart.turnOff") : t("ui-settings.autostart.turnOn")}
            </Button>
          </View>
        </>
      ) : (
        <Text style={[s.muted, { fontSize: 12 }]} testID="autostart-unsupported">
          {t("ui-settings.autostart.unsupported", { reason: st.reason || t("ui-settings.autostart.reasonUnknown") })}
        </Text>
      )}
      <ErrorBox text={error} />
    </View>
  );
}

type UpdateView = {
  release?: string | null;
  supervised?: boolean;
  reason?: string;
  update?: { kind: string; target: string; since: number } | null;
  request?: { mode: string; at?: number } | null;
  idle?: boolean;
  waitingFor?: { kind: string; session?: { id: string; title: string } }[];
  summary?: string;
  lastCancelled?: { at: number; reason: string };
};

export function UpdateSettings({
  client,
  catalog,
}: {
  client: DaisyClient;
  catalog: Catalog;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const when = useDaisyTime();
  const [st, setSt] = useState<UpdateView | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [confirm, setConfirm] = useState<{
      token: string;
      interrupts: { kind: string; session?: { title: string } }[];
    } | null>(null);
  const load = useCallback(async () => {
    try {
      setSt((await client.updateStatus()) as UpdateView);
    } catch (e: any) {
      setError(e.message);
    }
  }, [client]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, [load]);
  const au = autoUpdateLine(
    (catalog.nodes[0]?.capabilities as any)?.runner?.autoUpdate,
  );
  const tone = { ok: C.green, wait: C.orange, bad: C.red, muted: C.muted }[au.tone];
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      setConfirm(null);
      await load();
    } catch (e: any) {
      if (e instanceof DaisyError && e.code === "restart_interrupts") {
        // 409: what 「立即」 would interrupt, and a token for exactly that list.
        const body = e.body as any;
        setConfirm({
          token: body?.confirm || "",
          interrupts: body?.interrupts || [],
        });
        setError(e.message);
      } else setError(e.message);
    } finally {
      setBusy("");
    }
  };
  return (
    <View style={[s.card, { gap: 10 }]} testID="settings-update">
      <View style={[s.row, { flexWrap: "wrap" }]}>
        <View style={{ flex: 1, minWidth: 220, gap: 4 }}>
          <Text style={s.h3}>{t("ui-settings.update.title")}</Text>
          <Text style={[s.muted, { fontSize: 12 }]}>{t("ui-settings.update.intro")}</Text>
        </View>
        {st?.release ? <Badge text={t("ui-settings.update.release", { release: st.release.slice(0, 12) })} color={C.muted} /> : null}
      </View>
      <Text style={{ fontSize: 13, color: tone }} testID="update-auto">
        {au.text}
      </Text>
      {st ? (
        <View style={{ gap: 4 }}>
          {st.update ? (
            <Text style={{ fontSize: 13, color: C.ink }}>
              {t("ui-settings.update.pending", { target: st.update.target.slice(0, 12), since: when.time(st.update.since) })}
            </Text>
          ) : null}
          {st.request ? (
            <Text style={{ fontSize: 13, color: C.orange }} testID="update-request">
              {st.waitingFor?.length
                ? t(st.request.mode === "now" ? "ui-settings.update.requestedNowWaiting" : "ui-settings.update.requestedIdleWaiting", {
                    waiting: st.summary || t("ui-settings.update.workCount", { count: st.waitingFor.length }),
                  })
                : t(st.request.mode === "now" ? "ui-settings.update.requestedNow" : "ui-settings.update.requestedIdle")}
            </Text>
          ) : (
            <Text style={[s.muted, { fontSize: 12 }]}>
              {st.idle ? t("ui-settings.update.idle") : t("ui-settings.update.working", { summary: st.summary || "" })}
            </Text>
          )}
          {!st.supervised ? (
            <Text style={[s.muted, { fontSize: 12 }]}>
              {st.reason
                ? t("ui-settings.update.unsupervisedReason", { reason: st.reason })
                : t("ui-settings.update.unsupervised")}
            </Text>
          ) : null}
          {st.lastCancelled ? (
            <Text style={[s.muted, { fontSize: 12 }]}>
              {t("ui-settings.update.lastCancelled", { at: when.time(st.lastCancelled.at), reason: st.lastCancelled.reason })}
            </Text>
          ) : null}
        </View>
      ) : null}
      {confirm ? (
        <View style={{ gap: 6 }} testID="update-confirm">
          <Text style={{ fontSize: 13, color: C.red }}>
            {t("ui-settings.update.interrupts", {
              list:
                confirm.interrupts
                  .map((x) => x.session?.title || x.kind)
                  .join(t("ui-settings.sep")) || t("ui-settings.update.runningWork"),
            })}
          </Text>
          <View style={s.row}>
            <Button
              variant="danger"
              busy={busy === "confirm"}
              onPress={() => void run("confirm", () => client.restart("now", confirm.token))}
            >
              {t("ui-settings.update.confirm")}
            </Button>
            <Button variant="ghost" onPress={() => setConfirm(null)}>
              {t("ui-settings.update.notNow")}
            </Button>
          </View>
        </View>
      ) : null}
      <View style={[s.row, { flexWrap: "wrap" }]}>
        <Button
          variant="outline"
          testID="update-restart-idle"
          busy={busy === "idle"}
          onPress={() => void run("idle", () => client.restart("idle"))}
        >
          {t("ui-settings.update.restartIdle")}
        </Button>
        <Button
          variant="outline"
          testID="update-restart-now"
          busy={busy === "now"}
          onPress={() => void run("now", () => client.restart("now"))}
        >
          {t("ui-settings.update.restartNow")}
        </Button>
        {st?.request ? (
          <Button
            variant="ghost"
            testID="update-cancel"
            busy={busy === "cancel"}
            onPress={() => void run("cancel", () => client.cancelRestart())}
          >
            {t("ui-settings.update.cancel")}
          </Button>
        ) : null}
      </View>
      <ErrorBox text={error} />
    </View>
  );
}
