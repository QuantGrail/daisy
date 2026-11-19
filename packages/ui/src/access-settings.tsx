/**
 * P1-08: 设置 › 入口面与口令 (P1-03, ADR-110; D-09, D-24, D-31, 5.12).
 * GET /api/access; turning the outside face on or changing it, the
 * passcode and an outside link need the PIN (a grant from `usePin()`);
 * turning the outside face off does not (it narrows who gets in).
 *
 * P5-02 (ADR-144): 中转 — choose one (PIN: anyone who can reach the relay
 * can knock on the outside face), turn it off (PIN too, 5.10), see whether it is
 * connected, the address in the cards and what its certificate allows.
 *
 * D-38 (stage-2 gate): 允许的外部界面来源 (P2-04, ADR-115) — the browser
 * origins of external interfaces, outside face only. Adding one (a
 * whole-list PUT) wants the PIN; so does removing one while others stay
 * (the same PUT); removing the last one / clearing all does not (DELETE,
 * it narrows who gets in).
 */
import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import type { DaisyClient } from "@daisy-ai/client";
import type { AccessStatus, RelayStatus } from "@daisy-ai/contracts";
import { Badge, Button, ErrorBox, Field, Text } from "./primitives";
import { useDaisyTheme } from "./theme";
import { useDaisyHost, useDaisyTime } from "./host";
import { PinCancelled, usePin } from "./pin";
import { accessSummary } from "./settings-view";
import { copyText } from "./clipboard";
import { t as uiT, useT } from "./i18n";

const GATES = ["terminal", "shell", "browse"] as const;
/** A gate's name (`ui-access.gate.<id>`). */
const gateLabel = (id: (typeof GATES)[number]) => uiT.dynamic(`ui-access.gate.${id}`);

export function AccessSettings({ client }: { client: DaisyClient }) {
  const { C, s } = useDaisyTheme();
  const when = useDaisyTime();
  const { adapters } = useDaisyHost();
  const t = useT();
  const pin = usePin();
  const [st, setSt] = useState<AccessStatus | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [editing, setEditing] = useState(false),
    [host, setHost] = useState(""),
    [port, setPort] = useState(""),
    [tls, setTls] = useState(true),
    [allow, setAllow] = useState({ terminal: false, shell: false, browse: false }),
    [link, setLink] = useState<{
      url: string | null;
      code: string;
      expiresAt: number;
      warning: string | null;
      relayUrl: string | null;
      relayWarning: string | null;
    } | null>(null),
    [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    try {
      setSt(await client.access());
    } catch (e: any) {
      setError(e.message);
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  /** Run `fn` with a PIN grant; a closed PIN dialog is not an error. */
  const withPin = async (
    key: string,
    why: string,
    fn: (grant: string) => Promise<unknown>,
  ) => {
    setError("");
    setBusy(key);
    try {
      const g = await pin.grant(why);
      await fn(g);
      await load();
      return true;
    } catch (e: any) {
      if (!(e instanceof PinCancelled)) {
        // A grant that ran out between the dialog and the call.
        if (e.code === "pin_required") pin.forget();
        setError(e.message);
      }
      return false;
    } finally {
      setBusy("");
    }
  };
  if (!st)
    return (
      <View style={s.card} testID="settings-access">
        <Text style={s.h3}>{t("ui-access.title")}</Text>
        {error ? <ErrorBox text={error} /> : <Text style={s.muted}>{t("ui.common.loading")}</Text>}
      </View>
    );
  const ext = st.external;
  const startEdit = () => {
    setHost(ext.host || "");
    setPort(ext.port ? String(ext.port) : "");
    setTls(ext.enabled ? ext.tls : true);
    setAllow(ext.allow);
    setEditing(true);
    setError("");
  };
  return (
    <View style={[s.card, { gap: 12 }]} testID="settings-access">
      <View style={{ gap: 4 }}>
        <Text style={s.h3}>{t("ui-access.title")}</Text>
        <Text style={[s.muted, { fontSize: 12 }]} testID="access-summary">
          {accessSummary(st)}
        </Text>
      </View>
      <View style={{ gap: 6 }}>
        <Text style={s.label}>{t("ui-access.local.title")}</Text>
        <Text style={[s.muted, { fontSize: 12 }]}>
          {t("ui-access.local.line", { 
            url: st.local.url ? t("ui-access.local.url", { url: st.local.url }) : "",
            source: st.local.portSource ? t("ui-access.local.portSource", { source: portSource(st.local.portSource) }) : "",
           })}
        </Text>
      </View>
      <View style={{ gap: 8 }}>
        <View style={[s.row, { flexWrap: "wrap" }]}>
          <Text style={[s.label, { flex: 1 }]}>{t("ui-access.external.title")}</Text>
          <Badge
            text={ext.enabled ? (ext.listening ? t("ui-access.external.on") : t("ui-access.external.onNotListening")) : t("ui-access.external.off")}
            color={ext.enabled ? C.orange : C.muted}
          />
        </View>
        <Text style={[s.muted, { fontSize: 12 }]}>
          {t("ui-access.external.hint")}
        </Text>
        {ext.enabled ? (
          <View style={{ gap: 4 }}>
            <Text selectable style={[s.mono, { fontSize: 12 }]} testID="access-external-url">
              {ext.url || `${ext.host}:${ext.port ?? ""}`}
            </Text>
            {ext.fingerprint ? (
              <Text selectable style={[s.muted, { fontSize: 12 }]} testID="access-external-fingerprint">
                {t("ui-access.external.fingerprint", { fingerprint: ext.fingerprint })}
                {"\n"}
                {t("ui-access.external.fingerprintHint")}
              </Text>
            ) : null}
            <Text style={[s.muted, { fontSize: 12 }]}>
              {t("ui-access.external.gates", { 
                gates: GATES.map((g) =>
                  ext.allow[g] ? t("ui-access.gateOn", { gate: gateLabel(g) }) : t("ui-access.gateOff", { gate: gateLabel(g) }),
                ).join(t("ui-access.sep")),
               })}
            </Text>
          </View>
        ) : null}
        {editing ? (
          <View style={{ gap: 10, maxWidth: 460 }} testID="access-external-form">
            <Field
              label={t("ui-access.external.host")}
              value={host}
              onChange={setHost}
              placeholder={t("ui-access.external.hostExample")}
              testID="access-external-host"
            />
            <Field
              label={t("ui-access.external.port")}
              value={port}
              onChange={setPort}
              testID="access-external-port"
            />
            <Toggle
              label={t("ui-access.external.tls")}
              value={tls}
              onChange={setTls}
              testID="access-external-tls"
            />
            {GATES.map((g) => (
              <Toggle
                key={g}
                label={t("ui-access.external.allowGate", { gate: gateLabel(g) })}
                value={allow[g]}
                onChange={(v) => setAllow((a) => ({ ...a, [g]: v }))}
                testID={`access-external-allow-${g}`}
              />
            ))}
            <View style={s.row}>
              <Button
                testID="access-external-save"
                busy={busy === "on"}
                disabled={!host.trim()}
                onPress={() =>
                  void withPin("on", t("ui-access.external.pinWhy"), (g) =>
                    client.externalOn(
                      {
                        host: host.trim(),
                        ...(port.trim() ? { port: Number(port.trim()) } : {}),
                        tls,
                        allow,
                      },
                      g,
                    ),
                  ).then((ok) => ok && setEditing(false))
                }
              >
                {ext.enabled ? t("ui-access.external.save") : t("ui-access.external.turnOn")}
              </Button>
              <Button variant="ghost" onPress={() => setEditing(false)}>
                {t("ui-access.cancel")}
              </Button>
            </View>
          </View>
        ) : (
          <View style={[s.row, { flexWrap: "wrap" }]}>
            <Button variant="outline" testID="access-external-edit" onPress={startEdit}>
              {ext.enabled ? t("ui-access.external.edit") : t("ui-access.external.turnOnMore")}
            </Button>
            {ext.enabled ? (
              <>
                <Button
                  variant="outline"
                  testID="access-external-link"
                  busy={busy === "link"}
                  onPress={() =>
                    void withPin(
                      "link",
                      t("ui-access.external.linkPinWhy"),
                      async (g) => {
                        const r = await client.openCodeExternal(g);
                        setLink({ url: r.url, code: r.code, expiresAt: r.expiresAt, warning: r.warning, relayUrl: r.relayUrl, relayWarning: r.relayWarning });
                        setCopied(false);
                      },
                    )
                  }
                >
                  {t("ui-access.external.link")}
                </Button>
                <Button
                  variant="ghost"
                  testID="access-external-off"
                  busy={busy === "off"}
                  onPress={() =>
                    void (async () => {
                      setBusy("off");
                      setError("");
                      try {
                        setSt(await client.externalOff());
                        setLink(null);
                      } catch (e: any) {
                        setError(e.message);
                      } finally {
                        setBusy("");
                      }
                    })()
                  }
                >
                  {t("ui-access.external.turnOff")}
                </Button>
              </>
            ) : null}
          </View>
        )}
        {link ? (
          <View style={{ gap: 6 }} testID="access-external-link-box">
            <Text style={[s.muted, { fontSize: 12 }]}>
              {t("ui-access.link.once", { time: when.time(link.expiresAt) })}
              {link.url ? t("ui-access.link.open") : t("ui-access.link.noUrl")}
            </Text>
            <Text selectable style={[s.mono, { fontSize: 12 }]}>
              {link.url ?? link.code}
            </Text>
            {link.warning ? (
              <Text style={[s.muted, { fontSize: 12, color: C.red }]} testID="access-external-link-warning">
                {link.warning}
              </Text>
            ) : null}
            {link.relayUrl ? (
              <Text selectable style={[s.mono, { fontSize: 12 }]} testID="access-external-link-relay">
                {t("ui-access.link.relay", { url: link.relayUrl })}
              </Text>
            ) : null}
            {link.relayWarning ? (
              <Text style={[s.muted, { fontSize: 12, color: C.red }]} testID="access-external-link-relay-warning">
                {link.relayWarning}
              </Text>
            ) : null}
            {link.url ? (
              <View style={s.row}>
                <Button
                  variant="outline"
                  onPress={() =>
                    void copyText(link.url!, adapters.copyText)
                      .then(() => setCopied(true))
                      .catch((e) => setError(e.message))
                  }
                >
                  {copied ? t("ui-access.link.copied") : t("ui-access.link.copy")}
                </Button>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      <RelaySettings client={client} onChange={load} />
      <UiOriginsSettings client={client} externalEnabled={ext.enabled} />
      <View style={{ gap: 8 }}>
        <Text style={s.label}>{t("ui-access.passcode.title")}</Text>
        <Text style={[s.muted, { fontSize: 12 }]}>
          {t("ui-access.passcode.hint", { 
            state: st.passcode.effective ? t("ui-access.passcode.on") : t("ui-access.passcode.off"),
            shared: st.passcode.sharedHost ? t("ui-access.passcode.shared") : "",
           })}
        </Text>
        <View style={[s.row, { flexWrap: "wrap" }]} testID="access-passcode">
          {(["auto", "on", "off"] as const).map((m) => (
            <Button
              key={m}
              testID={`access-passcode-${m}`}
              variant={st.passcode.mode === m ? "primary" : "soft"}
              busy={busy === `pass-${m}`}
              onPress={() =>
                st.passcode.mode === m
                  ? undefined
                  : void withPin(`pass-${m}`, t("ui-access.passcode.pinWhy"), (g) =>
                      client.setPasscode(m, g),
                    )
              }
            >
              {t.dynamic(`ui-access.passcode.mode.${m}`)}
            </Button>
          ))}
        </View>
      </View>
      <ErrorBox text={error} />
    </View>
  );
}

/**
 * 允许的外部界面来源 (P2-04, ADR-115; D-38: outside face only): view, add
 * (PIN), remove (PIN while others stay; the last one / all: no PIN).
 */
export function UiOriginsSettings({
  client,
  externalEnabled,
}: {
  client: DaisyClient;
  externalEnabled: boolean;
}) {
  const { s } = useDaisyTheme();
  const t = useT();
  const pin = usePin();
  const [origins, setOrigins] = useState<string[] | null>(null),
    [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try {
      setOrigins((await client.uiOrigins()).origins);
    } catch (e: any) {
      setError(e.message);
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  /** Narrowing to nothing: no PIN (DELETE). */
  const clear = async (key: string) => {
    setError("");
    setBusy(key);
    try {
      setOrigins((await client.clearUiOrigins()).origins);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };
  /** A new whole list: the PIN (a closed PIN dialog is not an error). */
  const save = async (key: string, next: string[], why: string) => {
    setError("");
    setBusy(key);
    try {
      const g = await pin.grant(why);
      setOrigins((await client.setUiOrigins(next, g)).origins);
      return true;
    } catch (e: any) {
      if (!(e instanceof PinCancelled)) {
        if (e.code === "pin_required") pin.forget();
        setError(e.message);
      }
      return false;
    } finally {
      setBusy("");
    }
  };
  const list = origins ?? [];
  const remove = (o: string) => {
    const rest = list.filter((x) => x !== o);
    return rest.length
      ? save(`rm-${o}`, rest, t("ui-access.origins.removePinWhy"))
      : clear(`rm-${o}`);
  };
  const add = () =>
    void save("add", [...list, draft.trim()], t("ui-access.origins.addPinWhy")).then(
      (ok) => ok && setDraft(""),
    );
  return (
    <View style={{ gap: 8 }} testID="access-ui-origins">
      <View style={[s.row, { flexWrap: "wrap" }]}>
        <Text style={[s.label, { flex: 1 }]}>{t("ui-access.origins.title")}</Text>
      </View>
      <Text style={[s.muted, { fontSize: 12 }]}>
        {t("ui-access.origins.hint")}
        {externalEnabled ? "" : t("ui-access.origins.externalOff")}
      </Text>
      {origins === null && !error ? <Text style={s.muted}>{t("ui.common.loading")}</Text> : null}
      {origins !== null && !list.length ? (
        <Text style={[s.muted, { fontSize: 12 }]} testID="access-ui-origins-empty">
          {t("ui-access.origins.empty")}
        </Text>
      ) : null}
      {list.map((o) => (
        <View key={o} style={[s.row, { flexWrap: "wrap" }]} testID="access-ui-origin">
          <Text selectable style={[s.mono, { fontSize: 12, flex: 1 }]}>
            {o}
          </Text>
          <Button
            variant="ghost"
            testID={`access-ui-origin-remove-${o}`}
            busy={busy === `rm-${o}`}
            onPress={() => void remove(o)}
          >
            {t("ui-access.origins.remove")}
          </Button>
        </View>
      ))}
      <View style={{ gap: 10, maxWidth: 460 }}>
        <Field
          label={t("ui-access.origins.add")}
          value={draft}
          onChange={setDraft}
          placeholder={t("ui-access.origins.example")}
          testID="access-ui-origin-input"
        />
        <View style={[s.row, { flexWrap: "wrap" }]}>
          <Button
            variant="outline"
            testID="access-ui-origin-add"
            busy={busy === "add"}
            disabled={!draft.trim() || origins === null}
            onPress={add}
          >
            {t("ui-access.origins.addButton")}
          </Button>
          {list.length > 1 ? (
            <Button
              variant="ghost"
              testID="access-ui-origins-clear"
              busy={busy === "clear"}
              onPress={() => void clear("clear")}
            >
              {t("ui-access.origins.clear")}
            </Button>
          ) : null}
        </View>
      </View>
      <ErrorBox text={error} />
    </View>
  );
}

const PORT_SOURCES = ["derived", "remembered", "given", "moved"];
const portSource = (p: string) => (PORT_SOURCES.includes(p) ? uiT.dynamic(`ui-access.portSource.${p}`) : p);

export function Toggle({
  label,
  value,
  onChange,
  testID,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  testID?: string;
}) {
  const { s } = useDaisyTheme();
  const t = useT();
  const state = value ? t("ui-access.toggle.on") : t("ui-access.toggle.off");
  return (
    <View style={[s.row, { gap: 10 }]}>
      <Button
        testID={testID}
        variant={value ? "primary" : "soft"}
        accessibilityLabel={t("ui-access.toggle.a11y", { label, state })}
        onPress={() => onChange(!value)}
      >
        {state}
      </Button>
      <Text style={{ fontSize: 13, flex: 1 }}>{label}</Text>
    </View>
  );
}

/** A relay connection state in words (`ui-access.relay.state.<state>`). */
const relayState = (state: RelayStatus["state"]) => uiT.dynamic(`ui-access.relay.state.${state}`);

/** 中转 (P5-02, ADR-144): choose (PIN), off (PIN), status. */
export function RelaySettings({ client, onChange }: { client: DaisyClient; onChange?: () => void }) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const pin = usePin();
  const [st, setSt] = useState<RelayStatus | null>(null),
    [draft, setDraft] = useState(""),
    [acme, setAcme] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try {
      setSt(await client.relay());
    } catch (e: any) {
      setError(e.message);
    }
  }, [client]);
  useEffect(() => {
    void load();
    // The connection changes on its own (reconnects): look again now and then.
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  const choose = async () => {
    setError("");
    setBusy("set");
    try {
      const g = await pin.grant(t("ui-access.relay.setPinWhy"));
      setSt(await client.relaySet({ url: draft.trim(), acme }, g));
      setDraft("");
      onChange?.();
    } catch (e: any) {
      if (!(e instanceof PinCancelled)) {
        if (e.code === "pin_required") pin.forget();
        setError(e.message);
      }
    } finally {
      setBusy("");
    }
  };
  const off = async () => {
    setError("");
    setBusy("off");
    try {
      const g = await pin.grant(t("ui-access.relay.offPinWhy"));
      setSt(await client.relayOff(g));
      onChange?.();
    } catch (e: any) {
      if (!(e instanceof PinCancelled)) {
        if (e.code === "pin_required") pin.forget();
        setError(e.message);
      }
    } finally {
      setBusy("");
    }
  };
  return (
    <View style={{ gap: 8 }} testID="access-relay">
      <View style={[s.row, { flexWrap: "wrap" }]}>
        <Text style={[s.label, { flex: 1 }]}>{t("ui-access.relay.title")}</Text>
        {st ? (
          <Badge
            text={st.enabled ? relayState(st.state) : t("ui-access.relay.none")}
            color={st.state === "connected" ? C.orange : C.muted}
          />
        ) : null}
      </View>
      <Text style={[s.muted, { fontSize: 12 }]}>
        {t("ui-access.relay.hint")}
      </Text>
      {st?.enabled ? (
        <View style={{ gap: 4 }}>
          <Text selectable style={[s.mono, { fontSize: 12 }]} testID="access-relay-address">
            {st.address}
          </Text>
          <Text style={[s.muted, { fontSize: 12 }]} testID="access-relay-cert">
            {st.relay} · {st.cert.note}
            {st.cert.lastError ? t("ui-access.relay.certError", { error: st.cert.lastError }) : ""}
          </Text>
          {st.state !== "connected" && st.lastError ? <Text style={[s.muted, { fontSize: 12 }]}>{st.lastError}</Text> : null}
          <View style={s.row}>
            <Button variant="outline" testID="access-relay-off" busy={busy === "off"} onPress={() => void off()}>
              {t("ui-access.relay.off")}
            </Button>
          </View>
        </View>
      ) : null}
      <View style={{ gap: 10, maxWidth: 460 }}>
        <Field
          label={st?.enabled ? t("ui-access.relay.change") : t("ui-access.relay.address")}
          value={draft}
          onChange={setDraft}
          placeholder={t("ui-access.relay.example")}
          testID="access-relay-url"
        />
        <Toggle
          label={t("ui-access.relay.acme")}
          value={acme}
          onChange={setAcme}
          testID="access-relay-acme"
        />
        <View style={s.row}>
          <Button testID="access-relay-save" busy={busy === "set"} disabled={!draft.trim()} onPress={() => void choose()}>
            {st?.enabled ? t("ui-access.relay.switch") : t("ui-access.relay.choose")}
          </Button>
        </View>
      </View>
      <ErrorBox text={error} />
    </View>
  );
}
