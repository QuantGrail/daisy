/**
 * P5-03 (ADR-142, 5.11 「配对新设备、吊销设备」, W-3): 设置 › 设备.
 *
 * - The paired devices (GET /api/devices, `all`): name, when paired, last
 *   used and from where, state; the device this page runs on is marked.
 * - 配对新设备 (PIN): a pairing code, shown as the code, a QR of its link
 *   and the link itself, with when it runs out; it goes once a device
 *   paired since it was made shows up in the list (polled), or it ran out.
 *   Review L-2: a pairing lock (wrong codes typed) is shown, and said when
 *   a new code lifts it. The other device opens the
 *   link (or the outside face's page and types the code on its login
 *   screen). Pairing needs the outside face reachable: its listener on
 *   (设置 › 入口面与口令) or a relay (设置 › 中转). P5-03b (review M-1): the
 *   direct link first when the listener is on, the relay's on request with
 *   what its operator could do; only a relay: its link, said so; a relay
 *   with only a self-signed certificate: no link or QR — the code by hand
 *   (review L-1). Locks are per source (review L-2), each shown. The list
 *   says "经中转" for a device that last came through the relay.
 * - 吊销 (PIN): at once — its sessions, its live connection, its credential.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { DaisyClient } from "@daisy-ai/client";
import type { Device, PairingCode, PairLock } from "@daisy-ai/contracts";
import { Badge, Button, ErrorBox, Field, Text } from "./primitives";
import { useDaisyTheme } from "./theme";
import { useDaisyHost, useDaisyTime } from "./host";
import { PinCancelled, usePin } from "./pin";
import { copyText } from "./clipboard";
import { QrCode } from "./qr";
import { t as ut, useT } from "./i18n";
import type { MessageKey } from "@daisy-ai/contracts";

const STATE_KEY = {
  active: "ui-devices.state.active",
  expired: "ui-devices.state.expired",
  revoked: "ui-devices.state.revoked",
} as const satisfies Record<Device["state"], MessageKey>;
const WHY_KEY = {
  owner: "ui-devices.why.owner",
  self: "ui-devices.why.self",
  pin_reset: "ui-devices.why.pinReset",
} as const satisfies Record<NonNullable<Device["revokedWhy"]>, MessageKey>;

/** Review L-2: a locked source, in words (`external:ip:<a>`, `relay:<a>`). */
function lockSource(who: string): string {
  if (who.startsWith("relay:"))
    return who === "relay:?" ? ut("ui-devices.lock.relayUnknown") : ut("ui-devices.lock.relay", { source: who.slice(6) });
  const m = /^external:ip:(.+)$/.exec(who);
  return m ? m[1]! : who;
}

export function DeviceSettings({ client }: { client: DaisyClient }) {
  const { C, s } = useDaisyTheme();
  const t = useT();
  const when = useDaisyTime();
  const { adapters } = useDaisyHost();
  const pin = usePin();
  const [devices, setDevices] = useState<Device[] | null>(null),
    [showAll, setShowAll] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [name, setName] = useState(""),
    [code, setCode] = useState<PairingCode | null>(null),
    [copied, setCopied] = useState(false),
    /** P5-03b review M-1: show the relay's link (the alternative) instead of the direct one. */
    [alt, setAlt] = useState(false),
    [now, setNow] = useState(Date.now()),
    [locks, setLocks] = useState<PairLock[]>([]);
  /** When the shown code was made: a device paired since then used it. */
  const codeAt = useRef<number | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await client.devices(showAll ? "all" : "active");
      setDevices(r.devices);
      setLocks(r.pairLocks ?? []);
      const since = codeAt.current;
      if (since !== null && r.devices.some((d) => d.createdAt >= since)) {
        codeAt.current = null;
        setCode(null);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [client, showAll]);
  useEffect(() => {
    void load();
  }, [load]);
  // The code's countdown; once used (a new device shows up) or run out, it goes.
  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= code.expiresAt) {
        codeAt.current = null;
        setCode(null);
      } else void load();
    }, 3000);
    return () => clearInterval(timer);
  }, [code, load]);
  const withPin = async (key: string, why: string, fn: (grant: string) => Promise<unknown>) => {
    setError("");
    setBusy(key);
    try {
      await fn(await pin.grant(why));
      await load();
    } catch (e: any) {
      if (!(e instanceof PinCancelled)) {
        if (e.code === "pin_required") pin.forget();
        setError(e.message);
      }
    } finally {
      setBusy("");
    }
  };
  const left = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0;
  /** The link shown (QR, text, copy): the main one; the relay's on request (review M-1). Null: none — the code by hand. */
  const shown = code ? (alt && code.relayUrl ? code.relayUrl : code.url) : null;
  const shownWarning = code ? (alt && code.relayUrl ? code.relayWarning : code.warning) : null;
  return (
    <View style={[s.card, { gap: 12 }]} testID="settings-devices">
      <View style={{ gap: 4 }}>
        <Text style={s.h3}>{t("ui-devices.title")}</Text>
        <Text style={[s.muted, { fontSize: 12 }]}>{t("ui-devices.intro")}</Text>
      </View>
      {devices === null ? (
        <Text style={s.muted}>{error ? "" : t("ui.common.loading")}</Text>
      ) : devices.length === 0 ? (
        <Text style={[s.muted, { fontSize: 12 }]} testID="devices-empty">
          {t("ui-devices.empty")}
        </Text>
      ) : (
        <View style={{ gap: 8 }} testID="devices-list">
          {devices.map((d) => (
            <View
              key={d.id}
              testID={`device-${d.id}`}
              style={{ borderTopWidth: 1, borderColor: C.line, paddingTop: 10, gap: 4 }}
            >
              <View style={[s.row, { flexWrap: "wrap" }]}>
                <Text style={[s.label, { flex: 1 }]}>
                  {d.current ? t("ui-devices.current", { name: d.name }) : d.name}
                </Text>
                <Badge
                  text={t(STATE_KEY[d.state])}
                  color={d.state === "active" ? C.accent : d.state === "revoked" ? C.red : C.muted}
                />
              </View>
              <Text style={[s.muted, { fontSize: 12 }]}>
                {[
                  t("ui-devices.paired", { date: when.date(d.createdAt) }),
                  d.lastUsedAt
                    ? t("ui-devices.lastUsed", { date: when.date(d.lastUsedAt), time: when.time(d.lastUsedAt) })
                    : "",
                  d.lastVia === "relay"
                    ? d.lastIp
                      ? t("ui-devices.viaRelayFrom", { ip: d.lastIp })
                      : t("ui-devices.viaRelay")
                    : d.lastIp
                      ? t("ui-devices.from", { ip: d.lastIp })
                      : "",
                  d.revokedAt && d.revokedWhy
                    ? t("ui-devices.revokedWhy", { why: t(WHY_KEY[d.revokedWhy]), date: when.date(d.revokedAt) })
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
              {d.userAgent ? (
                <Text style={[s.muted, { fontSize: 11 }]} numberOfLines={1}>
                  {d.userAgent}
                </Text>
              ) : null}
              {d.state !== "revoked" ? (
                <View style={s.row}>
                  <Button
                    variant="ghost"
                    testID={`device-revoke-${d.id}`}
                    busy={busy === `revoke-${d.id}`}
                    onPress={() =>
                      void withPin(
                        `revoke-${d.id}`,
                        d.current ? t("ui-devices.revokeThisPin") : t("ui-devices.revokePin", { name: d.name }),
                        (g) => client.revokeDevice(d.id, g),
                      )
                    }
                  >
                    {t("ui-devices.revoke")}
                  </Button>
                </View>
              ) : null}
            </View>
          ))}
        </View>
      )}
      {locks.length ? (
        <View style={{ gap: 2 }} testID="devices-pair-locked">
          {locks.map((l) => (
            <Text key={l.who} style={[s.muted, { fontSize: 12, color: C.red }]}>
              {t("ui-devices.locked", { source: lockSource(l.who), until: when.time(l.until) })}
            </Text>
          ))}
        </View>
      ) : null}
      <View style={[s.row, { flexWrap: "wrap" }]}>
        <Button variant="ghost" testID="devices-show-all" onPress={() => setShowAll((v) => !v)}>
          {showAll ? t("ui-devices.showActive") : t("ui-devices.showAll")}
        </Button>
      </View>
      <View style={{ gap: 8, maxWidth: 460 }}>
        <Text style={s.label}>{t("ui-devices.pairTitle")}</Text>
        <Field
          label={t("ui-devices.pairName")}
          value={name}
          onChange={setName}
          placeholder={t("ui-devices.pairNamePlaceholder")}
          testID="devices-pair-name"
        />
        <View style={s.row}>
          <Button
            testID="devices-pair"
            busy={busy === "pair"}
            onPress={() =>
              void withPin("pair", t("ui-devices.pairPin"), async (g) => {
                codeAt.current = Date.now() - 1000;
                const c = await client.pairDevice(name.trim() || undefined, g);
                setCode(c);
                setAlt(false);
                setNow(Date.now());
                setCopied(false);
              })
            }
          >
            {t("ui-devices.pair")}
          </Button>
        </View>
      </View>
      {code ? (
        <View style={{ gap: 8, alignItems: "flex-start" }} testID="devices-pair-code">
          {code.wasLocked || code.recentFailures ? (
            <Text style={[s.muted, { fontSize: 12, color: C.red }]} testID="devices-pair-warning">
              {code.wasLocked
                ? t("ui-devices.failuresLocked", { count: code.recentFailures ?? 0 })
                : t("ui-devices.failures", { count: code.recentFailures ?? 0 })}
            </Text>
          ) : null}
          <Text style={[s.muted, { fontSize: 12 }]}>
            {shown ? t("ui-devices.howScan") : t("ui-devices.howByHand")}{" "}
            {t("ui-devices.onceLeft", { left: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` })}
          </Text>
          <Text
            selectable
            testID="devices-pair-code-text"
            style={{ fontSize: 28, letterSpacing: 4, color: C.accent, fontWeight: "700" }}
          >
            {code.code}
          </Text>
          {shownWarning ? (
            <Text style={[s.muted, { fontSize: 12, color: C.red }]} testID="devices-pair-cert-warning">
              {shownWarning}
            </Text>
          ) : null}
          {shown ? (
            <>
              <Text style={[s.muted, { fontSize: 12 }]} testID="devices-pair-via">
                {shown === code.relayUrl || code.via === "relay" ? t("ui-devices.relayAddress") : t("ui-devices.directAddress")}
              </Text>
              <QrCode value={shown} size={200} testID="devices-pair-qr" />
              <Text selectable style={[s.mono, { fontSize: 11 }]} testID="devices-pair-url">
                {shown}
              </Text>
            </>
          ) : null}
          {!alt && code.relayWarning && !code.relayUrl ? (
            <Text style={[s.muted, { fontSize: 12 }]} testID="devices-pair-relay-note">
              {code.relayWarning}
            </Text>
          ) : null}
          <View style={s.row}>
            {code.relayUrl ? (
              <Button variant="outline" testID="devices-pair-relay" onPress={() => setAlt((v) => !v)}>
                {alt ? t("ui-devices.useDirect") : t("ui-devices.useRelay")}
              </Button>
            ) : null}
            {shown ? (
              <Button
                variant="outline"
                onPress={() =>
                  void copyText(shown, adapters.copyText)
                    .then(() => setCopied(true))
                    .catch((e) => setError(e.message))
                }
              >
                {copied ? t("ui-devices.copied") : t("ui-devices.copyLink")}
              </Button>
            ) : null}
            <Button variant="ghost" onPress={() => setCode(null)}>
              {t("ui-devices.hide")}
            </Button>
          </View>
        </View>
      ) : null}
      <ErrorBox text={error} />
    </View>
  );
}
