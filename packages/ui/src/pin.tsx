/**
 * P1-08: the PIN in the local web page (P1-05's interface; D-11, D-36).
 *
 * - `PinProvider` keeps the PIN's state (polled) and answers `grant()`:
 *   an operation that needs the PIN (D-31 opening the outside face, the
 *   passcode, an outside link) asks for it here — a dialog takes the PIN,
 *   trades it for a short-lived grant (POST /api/pin/grant) and the
 *   operation sends that grant in `daisy-pin-grant`. The grant is kept in
 *   memory only, until it expires (5.11: 「输入一次后…短时间内有效」).
 * - `PinBanner`: while no PIN is set, every page says so (D-36: no AI
 *   turn starts until one is set).
 * - `PinSettings`: set or change it; when and through which entry it was
 *   set or reset (`setAt / setVia / resetAt / resetVia`; null → not shown).
 *
 * The routes are P1-05's (api.pin); a Daisy without them answers the
 * status read with an error and nothing of this shows (`available` false).
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Modal, View } from "react-native";
import { DaisyError, type DaisyClient, type PinStatusView } from "@daisy-ai/client";
import { Button, ErrorBox, Field, Text } from "./primitives";
import { useDaisyTheme, withAlpha } from "./theme";
import { useDaisyTime } from "./host";
import { pinBanner, pinErrorText, pinProvenance } from "./settings-view";
import { t as ut, useT } from "./i18n";

interface PinApi {
  /** null: not read yet, or this Daisy has no PIN interface. */
  status: PinStatusView | null;
  available: boolean;
  refresh: () => Promise<void>;
  /** A PIN grant for `why` (asks for the PIN when none is held). */
  grant: (why: string) => Promise<string>;
  /** Forget the held grant (e.g. after the PIN changed). */
  forget: () => void;
}
const PinContext = createContext<PinApi>({
  status: null,
  available: false,
  refresh: async () => {},
  grant: async () => {
    throw Error(ut("ui-login.pin.unavailable"));
  },
  forget: () => {},
});
export const usePin = () => useContext(PinContext);

/** The PIN was not given (dialog closed). */
export class PinCancelled extends Error {
  constructor() {
    super(ut("ui-login.pin.cancelled"));
  }
}

export function PinProvider({
  client,
  children,
}: React.PropsWithChildren<{ client: DaisyClient }>) {
  const [status, setStatus] = useState<PinStatusView | null>(null),
    [available, setAvailable] = useState(false),
    [asking, setAsking] = useState<{
      why: string;
      ok: (g: string) => void;
      no: (e: Error) => void;
    } | null>(null);
  const held = useRef<{ grant: string; expiresAt: number } | null>(null);
  const refresh = useCallback(async () => {
    try {
      const st = await client.pinStatus();
      setStatus(st);
      setAvailable(true);
    } catch (e) {
      // No PIN interface (before P1-05) or no answer: show nothing.
      if (e instanceof DaisyError && e.status !== 401) setAvailable(false);
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  const grant = useCallback(
    (why: string) => {
      const h = held.current;
      if (h && h.expiresAt - Date.now() > 5000) return Promise.resolve(h.grant);
      held.current = null;
      return new Promise<string>((ok, no) => setAsking({ why, ok, no }));
    },
    [],
  );
  const value = useMemo<PinApi>(
    () => ({
      status,
      available,
      refresh,
      grant,
      forget: () => {
        held.current = null;
      },
    }),
    [status, available, refresh, grant],
  );
  return (
    <PinContext.Provider value={value}>
      {children}
      {asking ? (
        <PinDialog
          client={client}
          why={asking.why}
          onGranted={(g) => {
            held.current = g;
            asking.ok(g.grant);
            setAsking(null);
          }}
          onClose={() => {
            asking.no(new PinCancelled());
            setAsking(null);
          }}
        />
      ) : null}
    </PinContext.Provider>
  );
}

function PinDialog({
  client,
  why,
  onGranted,
  onClose,
}: {
  client: DaisyClient;
  why: string;
  onGranted: (g: { grant: string; expiresAt: number }) => void;
  onClose: () => void;
}) {
  const { C, s, rad, sp } = useDaisyTheme();
  const t = useT();
  const [pin, setPin] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      onGranted(await client.pinGrant(pin));
    } catch (e: any) {
      setError(pinErrorText(e));
      setPin("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          backgroundColor: C.overlay,
          justifyContent: "center",
          alignItems: "center",
          padding: 20,
        }}
      >
        <View
          testID="pin-dialog"
          style={{
            backgroundColor: C.paper,
            borderRadius: rad(16),
            padding: sp(22),
            gap: sp(14),
            width: "100%",
            maxWidth: 420,
          }}
        >
          <Text style={s.h3}>{t("ui-login.pin.dialogTitle")}</Text>
          <Text style={s.muted}>
            {why}
            {"\n"}
            {t("ui-login.pin.dialogNote")}
          </Text>
          <Field
            label="PIN"
            value={pin}
            onChange={setPin}
            secret
            testID="pin-dialog-input"
          />
          <ErrorBox text={error} />
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            <Button variant="ghost" onPress={onClose}>
              {t("ui-login.cancel")}
            </Button>
            <Button
              testID="pin-dialog-submit"
              busy={busy}
              disabled={!pin}
              onPress={() => void submit()}
            >
              {t("ui-login.pin.ok")}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** D-36: over every page while no PIN is set. */
export function PinBanner({ onSet }: { onSet?: () => void }) {
  const { status } = usePin();
  const { C, s, sp } = useDaisyTheme();
  const t = useT();
  const when = useDaisyTime();
  const b = pinBanner(status);
  if (!b) return null;
  const history = pinProvenance(status, (ts) => `${when.date(ts)} ${when.time(ts)}`);
  return (
    <View
      testID="pin-banner"
      accessibilityRole="alert"
      style={{
        backgroundColor: withAlpha(C.red, "18"),
        borderBottomWidth: 1,
        borderColor: withAlpha(C.red, "55"),
        paddingHorizontal: sp(18),
        paddingVertical: sp(10),
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
      }}
    >
      <View style={{ flex: 1, minWidth: 220, gap: 2 }}>
        <Text style={{ color: C.red, fontWeight: "700", fontSize: 14 }}>
          {b.title}
        </Text>
        <Text style={[s.muted, { fontSize: 12 }]}>
          {b.detail}
          {history.length ? ` ${t("ui-login.pin.historySentence", { line: history[0]! })}` : ""}
        </Text>
      </View>
      {onSet ? (
        <Button testID="pin-banner-set" variant="danger" onPress={onSet}>
          {t("ui-login.pin.set")}
        </Button>
      ) : null}
    </View>
  );
}

/** One line under the navigation: when / through which entry (D-36). */
export function PinHistoryLine() {
  const { status } = usePin();
  const when = useDaisyTime();
  const { C } = useDaisyTheme();
  const lines = pinProvenance(status, (ts) => `${when.date(ts)} ${when.time(ts)}`);
  if (!status?.set || !lines.length) return null;
  return (
    <Text testID="pin-history" style={{ fontSize: 10, color: C.muted }} numberOfLines={2}>
      {lines[0]}
    </Text>
  );
}

/** 设置 › PIN: set it (first time), change it (with the old one). */
export function PinSettings({ client }: { client: DaisyClient }) {
  const { status, available, refresh, forget } = usePin();
  const { C, s } = useDaisyTheme();
  const t = useT();
  const when = useDaisyTime();
  const [open, setOpen] = useState(false),
    [pin, setPin] = useState(""),
    [again, setAgain] = useState(""),
    [old, setOld] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState("");
  if (!available)
    return (
      <View style={s.card} testID="settings-pin">
        <Text style={s.h3}>PIN</Text>
        <Text style={s.muted}>{t("ui-login.pin.noApi")}</Text>
      </View>
    );
  const isSet = !!status?.set;
  const history = pinProvenance(status, (ts) => `${when.date(ts)} ${when.time(ts)}`);
  const save = async () => {
    setError("");
    setDone("");
    if (pin !== again) return setError(t("ui-login.pin.mismatch"));
    setBusy(true);
    try {
      await client.setPin(pin, isSet ? old : undefined);
      forget();
      setPin("");
      setAgain("");
      setOld("");
      setOpen(false);
      setDone(isSet ? t("ui-login.pin.changed") : t("ui-login.pin.setDone"));
      await refresh();
    } catch (e: any) {
      setError(pinErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[s.card, { gap: 10 }]} testID="settings-pin">
      <View style={[s.row, { flexWrap: "wrap" }]}>
        <View style={{ flex: 1, minWidth: 220, gap: 4 }}>
          <Text style={s.h3}>PIN</Text>
          <Text style={[s.muted, { fontSize: 12 }]}>{t("ui-login.pin.intro")}</Text>
        </View>
        <Text
          testID="pin-state"
          style={{ color: isSet ? C.green : C.red, fontWeight: "700" }}
        >
          {isSet ? t("ui-login.pin.stateSet") : t("ui-login.pin.stateUnset")}
        </Text>
      </View>
      {status?.lockedUntil && status.lockedUntil > Date.now() ? (
        <ErrorBox
          text={t("ui-login.pin.lockedUntil", { until: when.time(status.lockedUntil) })}
        />
      ) : null}
      {history.map((h) => (
        <Text key={h} style={[s.muted, { fontSize: 12 }]} testID="pin-provenance">
          {h}
        </Text>
      ))}
      {done ? <Text style={{ color: C.green, fontSize: 13 }}>{done}</Text> : null}
      {open ? (
        <View style={{ gap: 10, maxWidth: 420 }}>
          {isSet ? (
            <Field label={t("ui-login.pin.old")} value={old} onChange={setOld} secret testID="pin-old" />
          ) : null}
          <Field
            label={t("ui-login.pin.new")}
            value={pin}
            onChange={setPin}
            secret
            testID="pin-new"
          />
          <Field
            label={t("ui-login.pin.again")}
            value={again}
            onChange={setAgain}
            secret
            testID="pin-again"
          />
          <ErrorBox text={error} />
          <View style={s.row}>
            <Button
              testID="pin-save"
              busy={busy}
              disabled={!pin || !again || (isSet && !old)}
              onPress={() => void save()}
            >
              {t("ui-login.pin.save")}
            </Button>
            <Button variant="ghost" onPress={() => setOpen(false)}>
              {t("ui-login.cancel")}
            </Button>
          </View>
        </View>
      ) : (
        <View style={s.row}>
          <Button
            testID="pin-open"
            variant={isSet ? "outline" : "primary"}
            onPress={() => {
              setOpen(true);
              setError("");
              setDone("");
            }}
          >
            {isSet ? t("ui-login.pin.change") : t("ui-login.pin.set")}
          </Button>
        </View>
      )}
    </View>
  );
}
