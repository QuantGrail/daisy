import React, { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, View, Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DaisyClient, DaisyError } from "@daisy-ai/client";
import {
  DaisyApp,
  DaisyHostProvider,
  DaisyThemeProvider,
  LoginScreen,
  codeFromHash,
  codeProblem,
  defaultDaisyTheme,
  hostBrandingProps,
  loadUiLanguage,
  forgetPairedDevice,
  keptSessionToken,
  pairCodeFromHash,
  pairedDeviceForPage,
  pairedDeviceClient,
  parsePairedDevice,
  watchPageShown,
  restorePairedDevice,
  withinBoot,
  uiLanguageLoaded,
  uiText,
  useT,
  readMigrated,
  type PairedDevice,
  type PairedDeviceClient,
} from "@daisy-ai/ui";
import type { HostBranding } from "@daisy-ai/contracts";
// P6-01 (ADR-151): the web shell only — the Expo native app (and its
// secure store) is gone; a phone opens Daisy in its browser.
// P6-03 (ADR-153): was daisy.auth.v1 (moved on first read).
const key = "daisy.auth.v1";
async function read() {
  try {
    return readMigrated(sessionStorage, key);
  } catch {
    return null;
  }
}
async function write(value: string | null) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Storage refused (a private window): signed in for this page only.
  }
}
// P5-03 (ADR-142): a paired device keeps its device credential across
// restarts of the browser (localStorage of this origin — the outside
// face's). The session it trades it for is kept like any web session
// (above).
const deviceKey = "daisy.device.v1";
async function readDevice(): Promise<PairedDevice | null> {
  try {
    // Review M-2: with the address it paired with, or not at all.
    return parsePairedDevice(localStorage.getItem(deviceKey));
  } catch {
    return null;
  }
}
async function writeDevice(d: PairedDevice) {
  try {
    localStorage.setItem(deviceKey, JSON.stringify(d));
  } catch {
    // Storage refused (a private window): the device stays paired for this tab only.
  }
}
/**
 * Forget `d` — only if it is still the stored one (review M-1: another tab
 * may have paired this browser anew; its credential stays).
 */
async function forgetDevice(d: PairedDevice) {
  try {
    forgetPairedDevice(localStorage, deviceKey, d);
  } catch {
    // Storage refused: nothing was kept.
  }
}
// Sub-path deployments (DAISY_BASE_PATH=/daisy at build time): Expo inlines
// the configured experiments.baseUrl, and the API lives under the same prefix.
const basePath = (process.env.EXPO_BASE_URL || "").replace(/\/+$/, "");
const url = window.location.origin + basePath;
/**
 * The passcode in the address bar's `#code=…`, taken out of it (never kept
 * there, never reused); null: none.
 */
function takeHashCode(): string | null {
  const code = codeFromHash(window.location.hash);
  if (code !== null)
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  return code;
}
/**
 * P5-03: the pairing code in the address bar's `#pair=…` (never in a
 * request line), taken out of it; null: none.
 */
function takeHashPair(): string | null {
  const code = pairCodeFromHash(window.location.hash);
  if (code !== null)
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  return code;
}
/**
 * P6-27 (P5N-7): where the first load is, on the page's root element
 * (`data-daisy-boot`) — for whoever looks at a page that seems stuck
 * (DevTools → Elements). Nothing secret: a stage name only.
 */
function bootStage(stage: string) {
  try {
    if (typeof document !== "undefined") document.documentElement.dataset.daisyBoot = stage;
  } catch {}
}
export default function App() {
  // P6-22: the whole page re-renders when the language changes (Settings → Display language).
  useT();
  const [client, setClient] = useState<DaisyClient | null>(null),
    [loginError, setLoginError] = useState({ text: "", n: 0 }),
    [pairCode, setPairCode] = useState(""),
    [paired, setPaired] = useState<PairedDevice | null>(null),
    [branding, setBranding] = useState<HostBranding | null>(null),
    [ready, setReady] = useState(false),
    // P6-27 (P5N-7): the first load gave up waiting (Daisy did not answer in time).
    [late, setLate] = useState(false);
  // The paired device's connection behind `client` (P6-27: its own check when the page is back).
  const deviceConn = useRef<PairedDeviceClient | null>(null);
  // The hashchange listener reads what is shown now (it is added once).
  const signedIn = useRef(false);
  signedIn.current = !!client;
  // Host branding (server DAISY_BRANDING via public /api/health): theme and
  // wording follow the embedding product, e.g. a host UI's palette and
  // 「工具授权」instead of 「审批」. Computed once per branding value.
  const brand = useMemo(() => hostBrandingProps(branding), [branding]);
  const failed = (text: string) =>
    setLoginError((e) => ({ text, n: e.n + 1 }));
  /** Trade a `daisy open` passcode for this page's session. */
  const trade = async (code: string) => {
    const problem = codeProblem(code, true);
    if (problem) return failed(problem);
    const c = new DaisyClient(url, "");
    try {
      await c.webSession(code);
      await write(JSON.stringify({ url: c.baseUrl, token: c.token }));
      setClient(c);
    } catch (e) {
      failed((e as Error).message);
    }
  };
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    // P4N-5: a new link opened in a tab that already shows this page only
    // changes the hash (no load): its passcode counts the same.
    const changed = () => {
      // P6-26 (P5N-5): so does a pairing link (`#pair=`) — on the login
      // screen it opens the pairing mode with the code filled in; signed
      // in already, it is only taken out of the address bar.
      const pair = takeHashPair();
      if (pair !== null) {
        if (!signedIn.current) {
          setPairCode(pair);
          // Review L-4: the message shown there (the device was revoked) stays.
          setLoginError((e) => ({ text: e.text, n: e.n + 1 }));
        }
        return;
      }
      const code = takeHashCode();
      if (code !== null) void trade(code);
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    // P6-20: the page's language is the pack's (setUiPack); a host's own
    // `lang` still wins (an "en" page makes Linux browsers pick Latin-first
    // fallback fonts, so a host that shows Chinese may say zh-CN).
    if (brand.lang) document.documentElement.lang = brand.lang;
    if (brand.title) document.title = brand.title;
  }, [brand]);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    // A file let go where nothing takes it (home, settings, the list): never
    // opened by the browser in place of the app. An AI conversation takes
    // files anywhere (chat-drop-zone.web.tsx).
    const keep = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types || []).includes("Files"))
        e.preventDefault();
    };
    window.addEventListener("dragover", keep);
    window.addEventListener("drop", keep);
    return () => {
      window.removeEventListener("dragover", keep);
      window.removeEventListener("drop", keep);
    };
  }, []);
  /**
   * P5-03: a paired device's connection — its session as the Bearer; when
   * that is refused (run out, 12 hours, revoked), the device credential is
   * traded for a new one (`credentials({ refresh: true })`, also for the
   * live socket — P6-26: at once when it closes). The trade refused (the
   * device was revoked): back to the login screen, told why, forgotten
   * (packages/ui/src/device-session.ts).
   */
  // Review M-2: always `device.url` — the credential is only ever sent to
  // the Daisy the device paired with, never the build-time default.
  const deviceClient = (device: PairedDevice, token = "") => {
    const d = pairedDeviceClient(device, token, {
      keep: {
        session: (t) => write(t ? JSON.stringify({ url: device.url, token: t }) : null),
        forget: () => forgetDevice(device),
      },
      gone: () => {
        deviceConn.current = null;
        setPaired(null);
        failed(uiText("ui.app.deviceGone"));
        setClient(null);
      },
    });
    deviceConn.current = d;
    return d;
  };
  // P6-26 / P6-27 (P5N-6, P5N-8): a paired device's page asks again the
  // moment it is back (shown, focused, online, back from the back-forward
  // cache, resumed after the browser froze it, or its watchdog finds it was
  // not running) — on a connection of its own, not behind whatever the
  // page was doing when it was frozen — and its live sockets are woken.
  useEffect(() => {
    const d = deviceConn.current;
    if (!client || !paired || !d || d.client !== client || Platform.OS !== "web" || typeof window === "undefined")
      return;
    return watchPageShown(d, window, document);
  }, [client, paired]);
  useEffect(() => {
    const brandingLoad =
      Platform.OS === "web"
        ? new DaisyClient(url, "")
            .health()
            .then(async (h) => {
              setBranding(h.branding ?? null);
              // P6-20 (ADR-159): the owner's language before the first frame.
              await loadUiLanguage(new DaisyClient(url, ""), h.language);
            })
            .catch(() => {})
        : Promise.resolve();
    const boot = async () => {
      // P5-03: the pairing link carries its code after `#pair=` (never in
      // a request line); taken out of the address bar at once.
      const pair = Platform.OS === "web" ? takeHashPair() : null;
      // P5-03: a paired device logs itself in with its own credential.
      // P6-26 (P5N-5): first, even with a `#pair=` link (a link the browser
      // completed from its history): a device whose pairing still holds is
      // let in, not shown the pairing screen. A new window has no session
      // yet: the credential is traded for one before the first frame (the
      // page shows its neutral connecting state meanwhile).
      // Review L-1: only a device paired with this page's Daisy, and the
      // kept session only if it was kept for that address (several Daisys
      // may share this origin under sub-paths).
      const device = pairedDeviceForPage(await readDevice(), url);
      if (device) {
        bootStage("device");
        const kept = await read().catch(() => null);
        const d = deviceClient(device, keptSessionToken(kept, device.url));
        const r = await restorePairedDevice(d);
        if (r.state === "in" || r.state === "outage") {
          // A temporary outage must not erase the pairing.
          setPaired(device);
          setClient(d.client);
          return;
        }
        // Refused otherwise (review L-2: the pairing is kept): say why.
        if (r.state === "refused" && r.error) failed(r.error.message);
        // Gone (forgotten, told why) or refused: the login screen — in the
        // pairing mode when a link brought a code.
        if (pair !== null) setPairCode(pair);
        return;
      }
      bootStage("session");
      if (pair !== null) {
        // The login screen opens in the pairing mode, the code filled in.
        setPairCode(pair);
        return;
      }
      if (Platform.OS === "web") {
        // P1-03 (5.12): the link `daisy open` printed carries a one-time
        // passcode after `#code=` (never sent to the server in a URL).
        const code = takeHashCode();
        if (code !== null) {
          await trade(code);
          return;
        }
      }
      const value = await read().catch(() => null);
      if (value) {
        const a = JSON.parse(value),
          c = new DaisyClient(a.url, a.token);
        try {
          await c.request("/me");
          setClient(c);
          return;
        } catch (e) {
          if (
            e instanceof DaisyError &&
            (e.status === 401 || e.status === 403)
          )
            await write(null);
          else {
            setClient(c); // A temporary outage must not erase a valid login.
            return;
          }
        }
      }
      if (Platform.OS !== "web") return;
      // On this machine with the passcode off, the page asks for a session
      // itself; otherwise the login screen asks for the passcode.
      const c = new DaisyClient(url, "");
      try {
        await c.webSession();
        await write(JSON.stringify({ url: c.baseUrl, token: c.token }));
        setClient(c);
      } catch {
        // Passcode on (a shared machine, the outside face): log in below.
      }
    };
    // Wait for branding too, so the first frame already has the host's look.
    bootStage("start");
    const booting = Promise.all([boot().catch(() => {}), brandingLoad]);
    // P6-27 (P5N-7): but never forever — after BOOT_LIMIT_MS the page shows
    // its login screen and says why (the load may still finish and let it in).
    void withinBoot(booting).then((r) => {
      bootStage(r === "late" ? "late" : "done");
      if (r === "late") {
        setLate(true);
        if (uiLanguageLoaded()) failed(uiText("ui.app.bootSlow"));
      }
      setReady(true);
    });
    void booting.then(() => bootStage("done"));
  }, []);
  const app = (
    <SafeAreaProvider>
      {late && !client && !uiLanguageLoaded() ? (
        // Gave up waiting before Daisy said a word (no language pack): signs only, and a reload.
        <View
          testID="boot-late"
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: (brand.theme ?? defaultDaisyTheme).colors.bg,
          }}
        >
          <Text style={{ fontSize: 16, marginBottom: 12 }}>⚠</Text>
          <Pressable
            testID="boot-reload"
            accessibilityRole="button"
            onPress={() => window.location.reload()}
            style={{ paddingHorizontal: 16, paddingVertical: 8 }}
          >
            <Text style={{ fontSize: 20 }}>↻</Text>
          </Pressable>
        </View>
      ) : !ready ? (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: (brand.theme ?? defaultDaisyTheme).colors.bg,
          }}
        >
          <Text>{uiLanguageLoaded() ? uiText("ui.app.connecting") : "…"}</Text>
        </View>
      ) : client ? (
        <DaisyApp
          client={client}
          host={brand.host}
          onLogout={() => {
            // P5-03: a paired device unpairs itself (its credential is
            // void on the server too, not only forgotten here).
            if (paired) void client.forgetDevice().catch(() => {});
            else void client.webLogout().catch(() => {});
            void write(null);
            // Review M-1: only this tab's device (another tab may have paired anew).
            if (paired) void forgetDevice(paired);
            deviceConn.current = null;
            setPaired(null);
            setClient(null);
          }}
          onToken={(token) => {
            client.token = token;
            void write(JSON.stringify({ url: client.baseUrl, token }));
          }}
        />
      ) : (
        <LoginScreen
          // A new failed link shows its error (the screen may be up already).
          key={loginError.n}
          defaultUrl={url}
          showUrl={Platform.OS !== "web"}
          initialError={loginError.text}
          initialPairCode={pairCode}
          onLogin={(c, device) => {
            void write(JSON.stringify({ url: c.baseUrl, token: c.token }));
            if (device) {
              void writeDevice(device);
              setPaired(device);
              setClient(deviceClient(device, c.token).client);
              return;
            }
            deviceConn.current = null;
            setClient(c);
          }}
        />
      )}
    </SafeAreaProvider>
  );
  const copied = brand.copy ? (
    <DaisyHostProvider copy={brand.copy}>{app}</DaisyHostProvider>
  ) : (
    app
  );
  return brand.theme ? (
    <DaisyThemeProvider value={brand.theme}>{copied}</DaisyThemeProvider>
  ) : (
    copied
  );
}
