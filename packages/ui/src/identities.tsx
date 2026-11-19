import { AGENT_IDS, identityChipText, shownName } from "@daisy-ai/contracts";
/**
 * P1-08: 设置 › harness 登录（身份档）. One Daisy, one machine (D-01): no
 * machine table any more (it was node-table.tsx — one card per execution
 * node, version column, remote devices). What stays is what the owner
 * does here: see which harnesses are installed, sign one in (an identity
 * of its own, official sign-in) or add one with an API key / an existing
 * CLI directory, and per identity its sign-in steps, auto-compact
 * threshold and deletion.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import type { Catalog, DaisyClient } from "@daisy-ai/client";
import {
  GLM_MODEL_SLOTS,
  MODEL_SLOTS,
  OFFICIAL_MODEL_SLOTS,
  glmModelPin,
  glmModelWarning,
  type Agent,
  type ModelSlots,
  type Profile,
} from "@daisy-ai/contracts";
import { Button, ErrorBox, Field, Text } from "./primitives";
import { useDaisyCopy } from "./host";
import { useDaisyTheme, withAlpha } from "./theme";
import { DeleteIdentity, LoginSteps, loginActive, loginStatus } from "./login";
import { AutoCompactSetting } from "./auto-compact";
import { Choices, Dialog } from "./index";
import { useT } from "./i18n";

const AGENTS = AGENT_IDS as Agent[];
type Login = { id: string; profileId: string; status: string; [k: string]: any };
const version = (v: unknown) =>
  /\d+(?:\.\d+)+[\w.+-]*/.exec(String(v ?? ""))?.[0] ?? "";

export function HarnessIdentities({
  client,
  catalog,
  onRefresh,
}: {
  client: DaisyClient;
  catalog: Catalog;
  onRefresh: () => Promise<void>;
}) {
  const { C, s, rad, agents: agentColor } = useDaisyTheme();
  const t = useT();
  const { labels } = useDaisyCopy();
  // This machine's in-process Runner (P1-02): the one node of the catalog.
  const node = catalog.nodes[0];
  const caps = (node?.capabilities || {}) as Record<string, any>;
  const installed = AGENTS.filter((a) => caps[a]?.installed);
  const profiles = useMemo(
    () => catalog.profiles.filter((p) => !node || p.nodeId === node.id),
    [catalog.profiles, node?.id],
  );
  const [jobs, setJobs] = useState<Login[]>([]),
    [open, setOpen] = useState<string | null>(null),
    [adding, setAdding] = useState(false),
    [form, setForm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const anyActive = jobs.some(loginActive);
  const reload = useCallback(async () => {
    setJobs(await client.request<Login[]>("/logins"));
  }, [client]);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      client
        .request<Login[]>("/logins")
        .then((r) => alive && setJobs(r))
        .catch(() => {});
    void poll();
    const timer = setInterval(poll, anyActive ? 2000 : 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, anyActive]);
  // A sign-in that just completed: the catalog's lastAuthenticatedAt moves.
  const done = jobs
    .filter((j) => j.status === "complete")
    .map((j) => j.id)
    .join();
  useEffect(() => {
    if (done) void onRefresh().catch(() => {});
  }, [done]);
  // A sign-in waiting for the owner opens once; 收起 is respected.
  const autoOpened = React.useRef(new Set<string>());
  useEffect(() => {
    const waiting = jobs.find(
      (j) =>
        (j.status === "waiting" || j.status === "running") &&
        !autoOpened.current.has(j.id),
    );
    if (!waiting) return;
    autoOpened.current.add(waiting.id);
    if (!open && profiles.some((p) => p.id === waiting.profileId))
      setOpen(waiting.profileId);
  }, [jobs]);
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
  const signIn = (agent: Agent) =>
    act(async () => {
      if (!node) throw Error(t("ui-identities.starting"));
      const p = await client.request<Profile>("/identities", "POST", {
        nodeId: node.id,
        agent,
        label: t("ui-identities.ownAccountLabel", {
          harness: labels[agent] ?? agent,
          date: new Date().toLocaleDateString(t.lang),
        }),
      });
      await client.request(`/profiles/${p.id}/login`, "POST", {});
      setAdding(false);
      setOpen(p.id);
    });
  const jobOf = (p: Profile) => jobs.find((j) => j.profileId === p.id);
  const detail = (p: Profile) => {
    const managed = p.configDir === `managed:${p.id}`;
    return (
      <View
        testID={`identity-detail-${p.id}`}
        style={{
          padding: 14,
          gap: 10,
          borderRadius: rad(10),
          backgroundColor: C.surfaceAlt,
          borderWidth: 1,
          borderColor: C.line,
        }}
      >
        <View style={[s.row, { flexWrap: "wrap" }]}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: C.ink }}>
            {shownName("profile", p, t)}
          </Text>
          <Text style={{ fontSize: 12, color: C.muted, flex: 1 }}>
            {managed
              ? t("ui-identities.kind.managed")
              : p.authMode === "apiKey"
                ? p.baseUrl
                  ? t("ui-identities.kind.apiKeyAt", { url: p.baseUrl })
                  : t("ui-identities.kind.apiKey")
                : p.configDir
                  ? t("ui-identities.kind.cliDir", { dir: p.configDir })
                  : t("ui-identities.kind.host")}
          </Text>
          <Button variant="ghost" onPress={() => setOpen(null)}>
            {t("ui-identities.collapse")}
          </Button>
        </View>
        <View style={{ maxWidth: 560 }}>
          <AutoCompactSetting client={client} profile={p} />
        </View>
        {managed ? (
          <View style={{ maxWidth: 520, gap: 10 }}>
            <LoginSteps
              client={client}
              profileId={p.id}
              job={jobOf(p)}
              busy={busy}
              act={act}
              onError={setError}
            />
          </View>
        ) : null}
        <View style={{ alignSelf: "flex-start", maxWidth: 520 }}>
          <DeleteIdentity
            client={client}
            profileId={p.id}
            managed={managed}
            onDeleted={async () => {
              setOpen(null);
              await reload();
              await onRefresh();
            }}
          />
        </View>
      </View>
    );
  };
  const opened = profiles.find((p) => p.id === open);
  return (
    <View style={[s.card, { gap: 12 }]} testID="settings-identities">
      <View style={[s.row, { flexWrap: "wrap" }]}>
        <View style={{ flex: 1, minWidth: 220, gap: 4 }}>
          <Text style={s.h3}>{t("ui-identities.title")}</Text>
          <Text style={[s.muted, { fontSize: 12 }]}>{t("ui-identities.intro")}</Text>
        </View>
        <Button variant="outline" testID="identity-add" onPress={() => setForm(true)}>
          {t("ui-identities.addOther")}
        </Button>
      </View>
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 11, color: C.muted, fontWeight: "500" }}>
          {t("ui-identities.installed")}
        </Text>
        {installed.length ? (
          <View
            style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 12 }}
            testID="harness-installed"
          >
            {installed.map((a) => (
              <Text key={a} style={{ fontSize: 13, color: C.ink }}>
                {labels[a]}
                <Text style={{ fontSize: 12, color: C.muted }}>
                  {" "}
                  {version(caps[a]?.version)}
                </Text>
              </Text>
            ))}
          </View>
        ) : (
          <Text style={{ fontSize: 13, color: C.faint }}>
            {node ? t("ui-identities.noneInstalled") : t("ui-identities.startingShort")}
          </Text>
        )}
      </View>
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 11, color: C.muted, fontWeight: "500" }}>
          {t("ui-identities.profiles")}
        </Text>
        {profiles.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {profiles.map((p) => {
              const st = loginStatus(jobOf(p), p);
              const tone =
                st.tone === "ok"
                  ? C.green
                  : st.tone === "wait"
                    ? C.orange
                    : st.tone === "bad"
                      ? C.red
                      : C.faint;
              const color = agentColor[p.agent] || C.accent;
              const sel = open === p.id;
              return (
                <Pressable
                  key={p.id}
                  testID={`identity-chip-${p.id}`}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: sel }}
                  onPress={() => setOpen(sel ? null : p.id)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: sel ? color : withAlpha(color, "33"),
                    backgroundColor: sel ? withAlpha(color, "1a") : C.paper,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <View
                    style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tone }}
                  />
                  <Text style={{ fontSize: 12, color: C.ink }} numberOfLines={1}>
                    {identityChipText(shownName("profile", p, t), p, st.text)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Text style={{ fontSize: 13, color: C.faint }}>{t("ui-identities.noProfiles")}</Text>
        )}
      </View>
      {opened ? detail(opened) : null}
      {adding ? (
        <View style={[s.row, { flexWrap: "wrap", gap: 6 }]}>
          {(installed.length ? installed : AGENTS).map((a) => (
            <Button
              key={a}
              variant="soft"
              busy={busy}
              testID={`identity-signin-${a}`}
              onPress={() => void signIn(a)}
            >
              {labels[a]}
            </Button>
          ))}
          <Button variant="ghost" onPress={() => setAdding(false)}>
            {t("ui-identities.cancel")}
          </Button>
        </View>
      ) : (
        <View style={s.row}>
          <Button variant="soft" testID="identity-signin" onPress={() => setAdding(true)}>
            {t("ui-identities.signIn")}
          </Button>
        </View>
      )}
      <ErrorBox text={error} />
      <Text style={[s.muted, { fontSize: 12 }]}>
        {t("ui-identities.footer")}
      </Text>
      {form ? (
        <ProfileForm
          client={client}
          nodeId={node?.id || ""}
          onClose={() => setForm(false)}
          onSaved={async () => {
            setForm(false);
            await onRefresh();
          }}
        />
      ) : null}
    </View>
  );
}

/** 「添加身份」: an API key / a compatible model, or an existing CLI directory. */
function ProfileForm({
  client,
  nodeId,
  onClose,
  onSaved,
}: {
  client: DaisyClient;
  nodeId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const { labels } = useDaisyCopy();
  const [values, setValues] = useState<Record<string, string>>({
      agent: "claude",
      authMode: "subscription",
      authHeader: "apiKey",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const v = (k: string) => values[k] || "",
    change = (k: string) => (value: string) =>
      setValues((x) => ({ ...x, [k]: value }));
  /** Provider presets (cc-switch): the four slot fields at once. */
  const fillSlots = (slots: ModelSlots, extra: Record<string, string> = {}) =>
    setValues((x) => ({
      ...x,
      ...Object.fromEntries(MODEL_SLOTS.map((k) => [`slot.${k}`, slots[k] || ""])),
      ...extra,
    }));
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await client.request("/profiles", "POST", {
        label: v("label"),
        nodeId,
        agent: v("agent"),
        authMode: v("authMode"),
        model: v("model"),
        baseUrl: v("baseUrl"),
        configDir: v("configDir"),
        apiKey: v("apiKey") || undefined,
        authHeader: v("authHeader"),
        // Claude Code model slots (empty = Claude Code's own).
        ...(v("agent") === "claude"
          ? {
              modelSlots: Object.fromEntries(
                MODEL_SLOTS.map((k) => [k, v(`slot.${k}`).trim()]),
              ),
            }
          : {}),
      });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("ui-identities.form.title")} onClose={onClose}>
      <Field label={t("ui-identities.form.label")} value={v("label")} onChange={change("label")} />
      <Choices
        value={v("agent")}
        onChange={(a) => {
          change("agent")(a);
          if (a !== "claude") change("authMode")("subscription");
        }}
        choices={AGENTS.map((a) => ({ id: a, label: labels[a] }))}
      />
      <Choices
        value={v("authMode")}
        onChange={change("authMode")}
        choices={[
          { id: "subscription", label: t("ui-identities.form.subscription") },
          ...(v("agent") === "claude"
            ? [{ id: "apiKey", label: t("ui-identities.form.apiKeyMode") }]
            : []),
        ]}
      />
      <Field
        label={t("ui-identities.form.model")}
        value={v("model")}
        onChange={change("model")}
        placeholder={t("ui-identities.form.modelPlaceholder")}
      />
      {v("agent") === "claude" ? (
        <>
          <Text style={s.muted}>{t("ui-identities.form.slotsIntro")}</Text>
          <View style={[s.row, { flexWrap: "wrap" }]}>
            <Button
              testID="profile-preset-glm"
              variant="soft"
              onPress={() =>
                // GLM: no fable slot; an empty or fable pin → opus[1m].
                fillSlots(GLM_MODEL_SLOTS, { model: glmModelPin(v("model")) })
              }
            >
              {t("ui-identities.form.presetGlm")}
            </Button>
            <Button
              testID="profile-preset-official"
              variant="soft"
              onPress={() => fillSlots(OFFICIAL_MODEL_SLOTS)}
            >
              {t("ui-identities.form.presetOfficial")}
            </Button>
          </View>
          {MODEL_SLOTS.map((k) => (
            <Field
              key={k}
              label={t("ui-identities.form.slot", { slot: k })}
              value={v(`slot.${k}`)}
              onChange={change(`slot.${k}`)}
              placeholder={k === "opus" ? t("ui-identities.form.slotExample") : t("ui-identities.form.slotDefault")}
            />
          ))}
          {(() => {
            const w = glmModelWarning(
              {
                baseUrl: v("baseUrl"),
                model: v("model"),
                modelSlots: Object.fromEntries(
                  MODEL_SLOTS.map((k) => [k, v(`slot.${k}`)]),
                ),
              },
              t,
            );
            return w ? (
              <Text testID="glm-model-warning" style={{ color: C.red, fontWeight: "600" }}>
                {w}
              </Text>
            ) : null;
          })()}
        </>
      ) : null}
      {v("authMode") === "apiKey" ? (
        <>
          <Field label="API key" value={v("apiKey")} onChange={change("apiKey")} secret />
          <Field
            label={t("ui-identities.form.baseUrl")}
            value={v("baseUrl")}
            onChange={change("baseUrl")}
            placeholder="https://api.example.com"
          />
          <Choices
            value={v("authHeader")}
            onChange={change("authHeader")}
            choices={[
              { id: "apiKey", label: "x-api-key" },
              { id: "bearer", label: "Bearer token" },
            ]}
          />
        </>
      ) : null}
      <Field
        label={t("ui-identities.form.configDir")}
        value={v("configDir")}
        onChange={change("configDir")}
        placeholder="~/.claude-work"
      />
      <Text style={s.muted}>{t("ui-identities.form.note")}</Text>
      <ErrorBox text={error} />
      <Button busy={busy} onPress={() => void submit()}>
        {t("ui-identities.form.save")}
      </Button>
    </Dialog>
  );
}
