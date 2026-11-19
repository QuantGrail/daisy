/**
 * P1-07 / P1-09: the local commands (LOCAL_COMMANDS in the contracts,
 * local-api.md §1) — they manage the process and files on this machine and
 * work when Daisy is not running. Where they need Daisy they call the
 * local API by its definitions' paths, like any client; none of them
 * reads or writes the database.
 */
import { COMMAND_NAME } from "../../../../contracts/src/names.ts";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, usageError } from "../errors.ts";
import { Daisy, health, locate, logFile, type Ctx } from "../daisy.ts";
import { CODE_ROOT, codeVersion, installKind, installedRelease, PACKAGE_NAME } from "../code.ts";
import {
  applyStopped,
  describeSource,
  latestFrom,
  noSourceText,
  nodeAutoUpdate,
  parseSource,
  previousPackage,
  sourceSet,
  readPending,
  readState,
  uninstallCommand,
  UpdateRefused,
} from "../../update/package.ts";
import { autostartHooks } from "../../platform/autostart-hooks.ts";
import { sweepOrphans } from "../../platform/process-groups.ts";
import { parseLocal, type LocalArgs, type LocalSpec } from "./options.ts";
import { PORT_MAX, PORT_MIN, portOk } from "../../../../contracts/src/start-files.ts";
import {
  managed,
  pinState,
  runningDaisy,
  startDaisy,
  stopDaisy,
} from "./process.ts";
import {
  autostartOff,
  autostartOn,
  autostartState,
  autostartSupport,
  launchdHint,
  lingerHint,
  type AutostartState,
} from "../../platform/autostart.ts";
import { doctor, settingsChecks } from "./doctor.ts";
import { CODE_KEYS, readRunnerJson } from "../../platform/settings.ts";
import { WATCH_HELP_PARAMS, watchEvents } from "./watch.ts";
import { callRoute, ROUTES } from "../routes.ts";
import { PIN_GRANT_HEADER } from "../../access/pin-seam.ts";
import { t } from "../lang.ts";

/**
 * P6-20 / P6-23 (ADR-159): a local command's text is in the packs — its
 * one-line summary `cli.local.<name>.summary`, its usage line
 * `cli.local.<name>.usage` and the rest of its --help `cli.local.<name>.help`.
 */
export interface LocalCommand {
  /** Values for the `{params}` of its usage and help text (beyond {product} / {command}). */
  helpParams?: () => Record<string, unknown>;
  spec: LocalSpec;
  run(ctx: Ctx, a: LocalArgs): Promise<number>;
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t("cli.time.seconds", { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("cli.time.minutes", { m });
  const h = Math.floor(m / 60);
  if (h < 48) return t("cli.time.hoursMinutes", { h, m: m % 60 });
  return t("cli.time.daysHours", { d: Math.floor(h / 24), h: h % 24 });
};

/** How the local face's port was chosen (`cli.status.portSource.<source>`). */
const PORT_SOURCES = new Set(["derived", "remembered", "given", "moved"]);

/** Display width: CJK and full-width characters take two columns. */
const width = (s: string) => [...s].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0);
/** A row whose label column fits the longest of `labels` (the current language's). */
const row = (labels: string[], k: string, v: string) => {
  const w = Math.max(10, ...labels.map((l) => width(l) + 2));
  return `  ${k}${" ".repeat(Math.max(1, w - width(k)))}${v}`;
};
/** A status row whose label is `cli.status.row.<key>` (the label column fits the longest label of the language). */
const ROW_KEYS = ["dataDir", "note", "autostart", "update", "version", "local", "external", "relay", "passcode", "managedBy", "pin", "lastUpdate", "autoUpdate", "problem"] as const;
const labelWidth = () => Math.max(10, ...ROW_KEYS.map((k) => width(t.dynamic(`cli.status.row.${k}`)) + 2));
const srow = (k: (typeof ROW_KEYS)[number] | "", v: string) => {
  const label = k ? t.dynamic(`cli.status.row.${k}`) : "";
  return `  ${label}${" ".repeat(Math.max(1, labelWidth() - width(label)))}${v}`;
};

async function tryCall(d: Daisy, id: string): Promise<any> {
  try {
    return (await callRoute(d, id)).data;
  } catch {
    return null;
  }
}

function autostartLine(ctx: Ctx, a: AutostartState | null): string {
  if (!a) return t("cli.status.autostart.unsupported");
  if (!a.installed) return t("cli.status.autostart.off");
  if (a.manager === "windows-run") return t("cli.status.autostart.windows", { unit: a.unit });
  if (a.manager === "launchd")
    return t(a.enabled ? "cli.status.autostart.launchdOn" : "cli.status.autostart.launchdDisabled", { unit: a.unit });
  return t(a.enabled ? "cli.status.autostart.systemdOn" : "cli.status.autostart.systemdDisabled", {
    unit: a.unit,
    linger: a.linger === false ? t("cli.status.autostart.noLinger") : "",
  });
}

// ── start ────────────────────────────────────────────────────────────────

const start: LocalCommand = {
  spec: { flags: { "--port": "value", "--foreground": "bool" } },
  async run(ctx, a) {
    let port: number | undefined;
    if (a.flags["--port"] !== undefined) {
      port = Number(a.flags["--port"]);
      if (!portOk(port))
        throw usageError(
          t("cli.local.start.portInvalid", { min: PORT_MIN, max: PORT_MAX, value: String(a.flags["--port"]) }),
          t("cli.local.start.portInvalidFix"),
        );
    }
    const r = await startDaisy(ctx, { port, foreground: a.flags["--foreground"] === true });
    if (r.already) {
      ctx.io.out(t("cli.local.start.alreadyRunning", { url: r.rt.local.url, pid: r.rt.pid, dataDir: r.rt.dataDir }));
    } else {
      ctx.io.out(t("cli.local.start.started", { url: r.rt.local.url }));
      const [pidL, dirL, logL, byL] = [
        t("cli.local.start.row.pid"),
        t("cli.status.row.dataDir"),
        t("cli.local.start.row.log"),
        t("cli.status.row.managedBy"),
      ];
      const labels = [pidL, dirL, logL, byL];
      ctx.io.out(row(labels, pidL, String(r.rt.pid)));
      ctx.io.out(row(labels, dirL, r.rt.dataDir));
      ctx.io.out(row(labels, logL, r.via === "systemd" ? `journalctl --user -u ${COMMAND_NAME}*` : logFile(ctx.dataDir)));
      if (r.via === "launchd") ctx.io.out(row(labels, byL, t("cli.local.start.managedLaunchd")));
      if (r.via === "windows-run") ctx.io.out(row(labels, byL, t("cli.local.start.managedWindows")));
      // macOS (N-9, ADR-140): a Daisy started as a background process from a
      // restricted shell cannot read the login keychain — say once, at
      // start, that launchd is the way there.
      if (r.via === "process" && ctx.io.platform === "darwin") ctx.io.out(t("cli.local.start.launchdAdvice"));
    }
    const daisy = Daisy.connect(ctx);
    const pin = await pinState(daisy).catch(() => null);
    if (pin && !pin.set) ctx.io.out(t("cli.pinNotSet"));
    if (!r.already) ctx.io.out(t(pin && !pin.set ? "cli.local.start.nextPin" : "cli.local.start.nextOpen"));
    return 0;
  },
};

// ── stop ─────────────────────────────────────────────────────────────────

const stop: LocalCommand = {
  spec: { flags: {} },
  async run(ctx) {
    const r = await stopDaisy(ctx);
    if (r.was === "absent") ctx.io.out(t("cli.local.stop.notRunning"));
    else if (r.was === "stale") ctx.io.out(t("cli.local.stop.stale", { pid: r.pid ?? "?" }));
    else
      ctx.io.out(
        t("cli.local.stop.stopped", {
          pid: r.pid ?? "?",
          via: r.via === "systemd" ? t("cli.local.stop.viaSystemd") : r.via === "launchd" ? t("cli.local.stop.viaLaunchd") : "",
        }),
      );
    return 0;
  },
};

// ── status ───────────────────────────────────────────────────────────────

const status: LocalCommand = {
  spec: { flags: { "--json": "bool" } },
  async run(ctx, a) {
    const f = locate(ctx.dataDir);
    const auto = await managed(ctx).catch(() => null);
    const up = f.state === "running" ? await health(f.rt.local.url) : null;
    const info: Record<string, any> = {
      running: !!up,
      dataDir: ctx.dataDir,
      installed: { version: codeVersion(), release: installedRelease(), kind: installKind() },
      autostart: auto
        ? { supported: true, manager: auto.manager, unit: auto.unit, installed: auto.installed, enabled: auto.enabled, active: auto.active, linger: auto.linger }
        : { supported: false, why: autostartLine(ctx, null) },
    };
    if (f.state === "stale") info.staleRuntime = { pid: f.rt.pid };
    // P5-06: the last update and one under way (files in the data directory, read when not running too).
    info.lastUpdate = readState(ctx.dataDir).history?.at(-1) ?? null;
    info.updatePending = readPending(ctx.dataDir);
    if (f.state === "running" && !up) info.notAnswering = { pid: f.rt.pid };
    // P6-11: broken start settings — what the running Daisy found at its
    // start, and what the files say now (the next start's).
    const problems = [
      ...new Set([
        ...(up && f.state === "running" && Array.isArray(f.rt.problems) ? f.rt.problems.map(String) : []),
        ...settingsChecks(ctx).filter((c) => c.level === "fail").map((c) => c.detail),
      ]),
    ];
    if (problems.length) info.problems = problems;
    if (up && f.state === "running") {
      const d = Daisy.connect(ctx);
      const [access, pin, update, catalog, relay] = await Promise.all([
        tryCall(d, ROUTES.access),
        pinState(d).catch(() => undefined),
        tryCall(d, ROUTES.updateStatus),
        tryCall(d, ROUTES.catalog),
        tryCall(d, ROUTES.relay),
      ]);
      Object.assign(info, {
        pid: f.rt.pid,
        startedAt: f.rt.startedAt,
        release: f.rt.release,
        managedBy:
          auto?.active && auto.mainPid === f.rt.pid
            ? auto.manager
            : // Windows: started by the Run entry's supervisor (it restarts it).
              auto?.manager === "windows-run" && auto.installed && update?.supervised === true
              ? "windows-run"
              : "process",
        local: f.rt.local,
        external: access?.external ?? f.rt.external,
        relay: relay ?? null,
        passcode: access?.passcode ?? null,
        pin: pin === undefined ? "unknown" : pin === null ? "unavailable" : pin,
        update: update
          ? { supervised: update.supervised, reason: update.reason, pending: update.update, request: update.request, summary: update.summary, ...(update.package ? { package: update.package } : {}) }
          : null,
        // P6-15 (P5N-2): the updater's own status first (what `update --source` just set), the node's report otherwise.
        autoUpdate: update?.package ? nodeAutoUpdate(update.package) : autoUpdateOf(catalog),
        log: auto?.active && auto.manager === "systemd" ? `journalctl --user -u ${auto.unit}` : logFile(ctx.dataDir),
      });
    }
    if (a.flags["--json"]) {
      ctx.io.out(JSON.stringify(info, null, 2));
      return info.running ? 0 : 3;
    }
    const o = (s: string) => ctx.io.out(s);
    if (!info.running) {
      o(f.state === "running" ? t("cli.status.notAnswering", { pid: f.rt.pid }) : t("cli.status.notRunning"));
      o(srow("dataDir", ctx.dataDir));
      if (f.state === "stale") o(srow("note", t("cli.status.staleNote", { pid: f.rt.pid })));
      o(srow("autostart", autostartLine(ctx, auto)));
      if (info.lastUpdate || info.updatePending) o(srow("update", lastUpdateText(info.lastUpdate, info.updatePending)));
      problemRows(o, info.problems);
      o(f.state === "running" ? t("cli.status.stuckHint", { log: logFile(ctx.dataDir) }) : t("cli.status.startHint"));
      return 3;
    }
    o(t("cli.status.running", { pid: info.pid, uptime: ago(Date.now() - info.startedAt) }));
    o(
      srow(
        "version",
        info.release
          ? t("cli.status.versionRelease", { version: codeVersion(), release: String(info.release).slice(0, 20) })
          : t("cli.status.versionCheckout", { version: codeVersion() }),
      ),
    );
    o(srow("dataDir", ctx.dataDir));
    const source = info.local.source ?? "";
    o(
      srow(
        "local",
        PORT_SOURCES.has(source)
          ? t("cli.status.localPortSource", { url: info.local.url, source: t.dynamic(`cli.status.portSource.${source}`) })
          : t("cli.status.localPort", { url: info.local.url }),
      ),
    );
    const ext = info.external;
    const onOff = (v: unknown) => t(v ? "cli.status.on" : "cli.status.off");
    o(
      srow(
        "external",
        ext?.listening || (ext?.url && ext?.listening !== false)
          ? t("cli.status.externalListening", {
              url: ext.url,
              transport: ext.tls ? "TLS" : t("cli.status.plaintext"),
              terminal: onOff(ext.allow?.terminal),
              shell: onOff(ext.allow?.shell),
              browse: onOff(ext.allow?.browse),
            }) +
            (typeof ext.fingerprint === "string" ? `\n${srow("", t("cli.status.fingerprint", { fingerprint: ext.fingerprint }))}` : "")
          : ext?.enabled
            ? t("cli.status.externalNotListening")
            : t("cli.status.externalOff"),
      ),
    );
    o(srow("relay", relayLine(info.relay)));
    if (info.passcode)
      o(
        srow(
          "passcode",
          t("cli.status.passcode", {
            mode: info.passcode.mode,
            effect: t(info.passcode.effective ? "cli.status.passcodeOn" : "cli.status.passcodeOff"),
            shared: info.passcode.sharedHost ? t("cli.status.passcodeShared") : "",
          }),
        ),
      );
    o(
      srow(
        "managedBy",
        info.managedBy === "process"
          ? t("cli.status.managed.process", { log: logFile(ctx.dataDir) })
          : info.managedBy === "launchd"
            ? t("cli.status.managed.launchd", { unit: String(auto?.unit), log: logFile(ctx.dataDir) })
            : info.managedBy === "windows-run"
              ? t("cli.status.managed.windows", { unit: String(auto?.unit), log: logFile(ctx.dataDir) })
              : t("cli.status.managed.systemd", { unit: String(auto?.unit) }),
      ),
    );
    o(srow("autostart", autostartLine(ctx, auto)));
    const pin = info.pin;
    o(
      srow(
        "pin",
        pin === "unavailable"
          ? t("cli.status.pin.unavailable")
          : pin === "unknown"
            ? t("cli.status.unreadable")
            : pin.set
              ? pin.lockedUntil && pin.lockedUntil > Date.now()
                ? t("cli.status.pin.locked", { until: new Date(pin.lockedUntil).toLocaleString(t.lang) })
                : t("cli.status.pin.set")
              : t("cli.status.pin.notSet"),
      ),
    );
    o(srow("update", updateLine(info.update)));
    if (info.lastUpdate || info.updatePending) o(srow("lastUpdate", lastUpdateText(info.lastUpdate, info.updatePending)));
    if (info.autoUpdate) o(srow("autoUpdate", autoUpdateLine(info.autoUpdate)));
    problemRows(o, info.problems);
    if (pin !== "unavailable" && pin !== "unknown" && !pin.set) {
      o("");
      o(t("cli.pinNotSet"));
    }
    return 0;
  },
};

/** P6-11: the start settings' problems, one row each, and where to look. */
function problemRows(o: (s: string) => void, problems: string[] | undefined) {
  if (!problems?.length) return;
  for (const p of problems) o(srow("problem", p));
  o(srow("", t("cli.status.problemHint")));
}

/** P5-02 (ADR-144): whether the relay is connected, its address, and what its certificate allows. */
export function relayLine(r: any): string {
  if (!r) return t("cli.status.unreadable");
  if (!r.enabled) return t("cli.status.relay.off");
  const state =
    r.state === "connected"
      ? t("cli.status.relay.connected")
      : r.state === "refused"
        ? t("cli.status.relay.refused")
        : r.state === "waiting"
          ? r.retryAt
            ? t("cli.status.relay.retryIn", { s: Math.max(1, Math.round((r.retryAt - Date.now()) / 1000)) })
            : t("cli.status.relay.retryLater")
          : r.state === "connecting"
            ? t("cli.status.relay.connecting")
            : t("cli.status.relay.disconnected");
  const why = r.state !== "connected" && r.lastError ? t("cli.status.relay.why", { why: r.lastError }) : "";
  const cert = r.cert?.kind === "acme" ? t("cli.status.relay.certAcme") : t("cli.status.relay.certSelf");
  const acme =
    r.cert?.kind !== "acme" && r.cert?.lastError
      ? t("cli.status.relay.certFailed", { why: String(r.cert.lastError).slice(0, 120) })
      : "";
  return t("cli.status.relay.line", { state, relay: r.relay, why, address: r.address ?? "—", cert, acme });
}

function updateLine(u: any): string {
  if (!u) return t("cli.status.unreadable");
  const parts: string[] = [];
  if (u.pending)
    parts.push(
      t(u.pending.kind === "release" ? "cli.status.update.installed" : "cli.status.update.found", {
        target: String(u.pending.target).slice(0, 30),
        waiting: u.summary,
      }),
    );
  if (u.request) parts.push(t(u.request.mode === "now" ? "cli.status.update.restartNow" : "cli.status.update.restartIdle"));
  if (!u.supervised) parts.push(t("cli.status.update.foreground"));
  if (u.package?.supported && !u.pending)
    parts.push(
      u.package.sourceSet === false
        ? t("cli.status.update.autoNoSource")
        : u.package.auto
          ? t("cli.status.update.autoOn", { source: u.package.source })
          : t("cli.status.update.autoOff"),
    );
  if (u.package?.error) parts.push(t("cli.status.update.error", { error: u.package.error }));
  return parts.length ? parts.join(t("cli.list.separator")) : t("cli.status.update.nothing");
}

const when = (at: number) => new Date(at).toLocaleString(t.lang);
/** An update's outcome (`cli.status.result.<result>`), or the raw value. */
const resultText = (r: string) => (t.has(`cli.status.result.${r}`) ? t.dynamic(`cli.status.result.${r}`) : r);

/** P5-06: 「0.1.0+a → 0.2.0+b 已换上（时间）」, or why it went back. */
function lastUpdateText(last: any, pending: any): string {
  if (pending?.to)
    return t(pending.rolledBack ? "cli.status.lastUpdate.rollingBack" : "cli.status.lastUpdate.trying", { from: pending.from ?? "?", to: pending.to });
  if (!last) return t("cli.status.none");
  return t("cli.status.lastUpdate.done", {
    from: last.from ?? "?",
    to: last.to,
    result: resultText(last.result),
    at: when(last.at),
    reason: last.reason ? t("cli.status.lastUpdate.reason", { reason: String(last.reason).slice(0, 200) }) : "",
    backup: last.backup ? t("cli.status.lastUpdate.backup", { backup: last.backup }) : "",
  });
}

// ── open ─────────────────────────────────────────────────────────────────

/**
 * P5-03b: `daisy open --external`'s link — the direct listener's first, the
 * relay's as the alternative with what its operator could do (review M-1);
 * none at all for a relay with only a self-signed certificate (review L-1:
 * the passcode typed by hand, and never click through the warning).
 */
export function renderExternalLink(data: any, out: (line: string) => void): void {
  if (typeof data?.url === "string") out(data.url);
  else {
    out(t("cli.local.open.noLink"));
    out(String(data?.code ?? ""));
  }
  if (typeof data?.warning === "string" && data.warning) out(t("cli.local.open.warning", { warning: data.warning }));
  if (typeof data?.fingerprint === "string" && data.fingerprint) out(t("cli.local.open.fingerprint", { fingerprint: data.fingerprint }));
  if (typeof data?.relayUrl === "string") out(t("cli.local.open.relayLink", { url: data.relayUrl }));
  if (typeof data?.relayWarning === "string" && data.relayWarning) out(t("cli.local.open.warning", { warning: data.relayWarning }));
}

const open: LocalCommand = {
  spec: { flags: { "--external": "bool", "--print": "bool" } },
  async run(ctx, a) {
    const d = Daisy.connect(ctx);
    const external = a.flags["--external"] === true;
    const headers: Record<string, string> = {};
    if (external) headers[PIN_GRANT_HEADER] = await d.pinGrant();
    const r = await callRoute(d, external ? ROUTES.openCodeExternal : ROUTES.openCode, { headers });
    const url: string | null = r.data?.url ?? null;
    // P5-03b review L-1: a relay with only a self-signed certificate gives no link (the passcode by hand).
    if (external && url === null && typeof r.data?.code === "string") {
      renderExternalLink(r.data, (x) => ctx.io.out(x));
      return 0;
    }
    if (typeof url !== "string") throw new CliError(t("cli.local.open.noUrl"), t("cli.local.open.noUrlFix"));
    const env = ctx.io.env;
    const remote = !!(env.SSH_CONNECTION || env.SSH_TTY);
    const headless = ctx.io.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
    const tryOpen = !a.flags["--print"] && !external && !remote && !headless;
    const opened = tryOpen && ctx.io.openUrl(url);
    ctx.io.out(t(opened ? "cli.local.open.opened" : "cli.local.open.openThis"));
    if (external) renderExternalLink(r.data, (x) => ctx.io.out(x));
    else ctx.io.out(url);
    if (remote && !external) {
      const port = d.rt.local.port;
      ctx.io.out(t("cli.local.open.ssh", { port }));
    }
    const pin = await pinState(d).catch(() => null);
    if (pin && !pin.set) ctx.io.out(t("cli.pinNotSet"));
    return 0;
  },
};

// ── update ───────────────────────────────────────────────────────────────

const update: LocalCommand = {
  helpParams: () => ({ package: PACKAGE_NAME }),
  spec: { flags: { "--check": "bool", "--apply": "bool", "--from": "value", "--allow-downgrade": "bool", "--rollback": "bool", "--now": "bool", "--cancel": "bool", "--source": "value" } },
  async run(ctx, a) {
    const modes = ["--check", "--apply", "--rollback", "--now", "--cancel", "--source"].filter((k) => a.flags[k] !== undefined);
    if (modes.length > 1)
      throw usageError(t("cli.local.update.modesTogether", { modes: modes.join(t("cli.local.update.modesJoin")) }), t("cli.local.update.modesTogetherFix"));
    if ((a.flags["--from"] !== undefined || a.flags["--allow-downgrade"]) && !a.flags["--apply"])
      throw usageError(t("cli.local.update.fromNeedsApply"), t("cli.local.update.fromNeedsApplyFix"));
    const from = typeof a.flags["--from"] === "string" ? resolve(String(a.flags["--from"])) : undefined;
    const f = locate(ctx.dataDir);
    const up = f.state === "running" && (await health(f.rt.local.url));
    const own = installedRelease();
    if (a.flags["--source"] !== undefined) {
      // Changes what code runs from now on: the PIN, which only a running Daisy checks.
      if (!up) throw new CliError(t("cli.local.update.sourceNeedsPin"), t("cli.local.update.sourceNeedsPinFix"));
      const raw = String(a.flags["--source"]);
      const value = raw === "none" ? null : raw === "off" || raw.startsWith("npm:") ? raw : resolve(raw);
      const d = Daisy.connect(ctx);
      const r = await callRoute(d, ROUTES.updateSourceSet, { body: { source: value }, headers: { [PIN_GRANT_HEADER]: await d.pinGrant() } }).catch((e: any) => {
        if (e?.code === "invalid_source") throw new CliError(e.message, t("cli.local.update.invalidSourceFix"));
        return unavailable(e);
      });
      const p = r.data?.package;
      ctx.io.out(
        value === null
          ? t("cli.local.update.sourceRemoved")
          : t("cli.local.update.sourceSet", {
              source: p?.source ?? value,
              auto: t(p?.auto ? "cli.local.update.sourceAutoOn" : "cli.local.update.sourceAutoOff"),
            }),
      );
      return 0;
    }
    if (!up) {
      if (a.flags["--now"] || a.flags["--cancel"]) throw new CliError(t("cli.local.update.noProcess"), t("cli.local.update.noProcessFix"));
      if (a.flags["--check"]) return checkStopped(ctx, own);
      if (a.flags["--apply"] || a.flags["--rollback"]) return applyWhileStopped(ctx, own, a.flags["--rollback"] ? "rollback" : { from, allowDowngrade: a.flags["--allow-downgrade"] === true });
      ctx.io.out(onDiskLine(own));
      ctx.io.out(t("cli.local.update.stoppedUsesThis"));
      lastUpdateLines(ctx, readState(ctx.dataDir).history?.at(-1) ?? null, readPending(ctx.dataDir));
      ctx.io.out(howToUpdate());
      return 0;
    }
    const d = Daisy.connect(ctx);
    if (a.flags["--cancel"]) {
      const r = await callRoute(d, ROUTES.updateCancel);
      ctx.io.out(t(r.data?.cancelled ? "cli.local.update.cancelled" : "cli.local.update.nothingToCancel"));
      return 0;
    }
    if (a.flags["--now"]) return updateNow(ctx, d);
    if (a.flags["--check"]) {
      const r = await callRoute(d, ROUTES.updateCheck).catch(unavailable);
      packageLines(ctx, r.data?.package);
      return 0;
    }
    if (a.flags["--rollback"]) {
      const prev = previousPackage(ctx.dataDir, (await callRoute(d, ROUTES.updateStatus)).data?.release ?? own);
      if (!prev) throw new CliError(t("cli.local.update.noPrevious"), t("cli.local.update.noPreviousFix"));
      return applyRunning(ctx, d, { from: prev, allowDowngrade: true });
    }
    if (a.flags["--apply"]) {
      const st = (await callRoute(d, ROUTES.updateStatus)).data ?? {};
      // Installed by hand (npm install -g) and not yet switched to, or not
      // an npm install at all (a checkout after git pull): restart into the
      // code on disk once idle.
      const onDisk = st.update?.kind === "release" || (!!own && !!st.release && own !== st.release);
      if (!from && (onDisk || !st.package?.supported)) {
        const r = await callRoute(d, ROUTES.updateRestart, { body: { mode: "idle" } });
        const waiting = r.data?.waitingFor ?? [];
        const target = st.update?.target ?? own;
        const into = target ? t("cli.local.update.restartTarget", { target }) : "";
        ctx.io.out(
          waiting.length
            ? t("cli.local.update.restartWaiting", { n: waiting.length, target: into })
            : t("cli.local.update.restartSoon", { target: into }),
        );
        if (st.package?.supported) ctx.io.out(t("cli.local.update.backupNote"));
        return 0;
      }
      return applyRunning(ctx, d, { from, allowDowngrade: a.flags["--allow-downgrade"] === true });
    }
    const st = (await callRoute(d, ROUTES.updateStatus)).data ?? {};
    const running = st.release ?? f.rt.release;
    ctx.io.out(onDiskLine(own));
    ctx.io.out(running ? t("cli.local.update.runningVersion", { version: running }) : t("cli.local.update.runningCheckout"));
    if (own && running && own !== running && !st.update)
      ctx.io.out(t("cli.local.update.installedPending", { later: st.supervised ? t("cli.local.update.installedLater") : "" }));
    if (st.update)
      ctx.io.out(t(st.update.kind === "release" ? "cli.local.update.pendingRelease" : "cli.local.update.pendingFound", { target: st.update.target }));
    if (st.request) ctx.io.out(t(st.request.mode === "now" ? "cli.local.update.requestNow" : "cli.local.update.requestIdle"));
    if (st.update || st.request) ctx.io.out(t("cli.local.update.waitingFor", { what: st.summary ?? t("cli.local.update.waitingNothing") }));
    if (st.package) packageLines(ctx, st.package);
    else {
      const au = autoUpdateOf(await tryCall(d, ROUTES.catalog));
      if (au) ctx.io.out(t("cli.local.update.autoUpdate", { state: autoUpdateLine(au) }));
    }
    ctx.io.out(
      st.supervised
        ? t("cli.local.update.supervised", { by: supervisedBy(st) })
        : t("cli.local.update.notSupervised", { reason: st.reason ? t("cli.local.update.reason", { reason: st.reason }) : "" }),
    );
    ctx.io.out(howToUpdate());
    return 0;
  },
};

const supervisedBy = (st: any) => {
  const m = st?.supervision?.manager ?? st?.manager;
  return m === "systemd" ? "systemd" : m === "launchd" ? "launchd" : t(m === "respawn" ? "cli.local.update.byRespawn" : "cli.local.update.byManager");
};

/** The version installed on disk (and its release tag). */
const onDiskLine = (own: string | null) =>
  own ? t("cli.local.update.onDiskRelease", { version: codeVersion(), release: own }) : t("cli.local.update.onDisk", { version: codeVersion() });

/** Same commands on every system (D-41 ④). */
const howToUpdate = () => t("cli.local.update.howTo");

const unavailable = (e: any): never => {
  if (e?.code === "update_unavailable") throw new CliError(e.message, t("cli.local.update.seeStatusFix"));
  throw e;
};

async function applyRunning(ctx: Ctx, d: Daisy, body: { from?: string; allowDowngrade?: boolean }): Promise<number> {
  const r = await callRoute(d, ROUTES.updateApply, { body: { ...(body.from ? { from: body.from } : {}), ...(body.allowDowngrade ? { allowDowngrade: true } : {}) } }).catch(unavailable);
  const p = r.data?.package;
  const waiting = r.data?.waitingFor ?? [];
  const target = p?.available?.release ?? p?.available?.version ?? "?";
  ctx.io.out(
    waiting.length ? t("cli.local.update.applyWaiting", { target, n: waiting.length }) : t("cli.local.update.applySoon", { target }),
  );
  ctx.io.out(t("cli.local.update.applySteps"));
  return 0;
}

/** --check without a running Daisy: the command line asks the source itself. */
async function checkStopped(ctx: Ctx, own: string | null): Promise<number> {
  const source = parseSource(runnerSetting(ctx, "updateSource") ?? ctx.io.env.DAISY_UPDATE_SOURCE);
  if (!sourceSet(source))
    throw new CliError(
      source.kind === "off" ? t("cli.local.update.sourceOff") : t("cli.local.update.autoUpdate", { state: noSourceText(t) }),
      t("cli.local.update.noSourceFix"),
    );
  try {
    const c = await latestFrom(source, { dataDir: ctx.dataDir, own });
    ctx.io.out(
      c
        ? t("cli.local.update.newVersion", { version: c.release ?? c.version, source: describeSource(source) })
        : t("cli.local.update.upToDate", { version: own ?? codeVersion(), source: describeSource(source) }),
    );
    return 0;
  } catch (e) {
    throw new CliError(
      t("cli.local.update.checkFailed", { message: (e as Error).message }),
      t("cli.local.update.checkFailedFix", { source: describeSource(source) }),
    );
  }
}

async function applyWhileStopped(ctx: Ctx, own: string | null, what: "rollback" | { from?: string; allowDowngrade?: boolean }): Promise<number> {
  let from: string | undefined, allowDowngrade: boolean | undefined;
  if (what === "rollback") {
    const prev = previousPackage(ctx.dataDir, own);
    if (!prev) throw new CliError(t("cli.local.update.noPrevious"), t("cli.local.update.noPreviousFix"));
    from = prev;
    allowDowngrade = true;
  } else ({ from, allowDowngrade } = what);
  try {
    ctx.io.out(t("cli.local.update.installingStopped"));
    const r = await applyStopped({
      dataDir: ctx.dataDir,
      codeRoot: CODE_ROOT,
      own,
      from,
      allowDowngrade,
      source: runnerSetting(ctx, "updateSource") ?? ctx.io.env.DAISY_UPDATE_SOURCE,
    });
    ctx.io.out(t("cli.local.update.installed", { to: r.to, from: String(own), fallback: r.fromPackage }));
    ctx.io.out(t("cli.local.update.nextStart", { to: r.to, from: String(own) }));
    return 0;
  } catch (e) {
    if (e instanceof UpdateRefused) throw new CliError(e.message, t("cli.local.update.seeStatusFix"));
    throw e;
  }
}

/**
 * A runner.json setting (the command line reads the file; it is not the
 * database). P6-16 (ADR-160): one that decides which code runs is not taken
 * from a file another account can write — said on stderr.
 */
function runnerSetting(ctx: Ctx, key: string): string | undefined {
  const r = readRunnerJson(ctx.dataDir);
  if (r.distrust && (CODE_KEYS as readonly string[]).includes(key))
    ctx.io.err(t("cli.local.update.distrusted", { file: join(ctx.dataDir, "runner.json"), why: r.distrust, key }));
  const v = r.config?.[key];
  return typeof v === "string" ? v : undefined;
}


/** The last outcome and a switch under way (status, update). */
function lastUpdateLines(ctx: Ctx, last: any, pending: any) {
  if (pending?.to)
    ctx.io.out(
      pending.rolledBack
        ? t("cli.local.update.inProgressRollingBack", { from: pending.from ?? "?", to: pending.to })
        : t("cli.local.update.inProgressTrying", { from: pending.from ?? "?", to: pending.to, starts: pending.starts ?? 0 }),
    );
  if (last) {
    ctx.io.out(
      t("cli.local.update.last", {
        from: last.from ?? "?",
        to: last.to,
        result: resultText(last.result),
        at: when(last.at),
        reason: last.reason ? t("cli.local.update.lastReason", { reason: last.reason }) : "",
      }),
    );
    if (last.backup) ctx.io.out(t("cli.local.update.lastBackup", { backup: last.backup }));
  }
}

function packageLines(ctx: Ctx, p: any) {
  if (!p) return;
  if (!p.supported) {
    ctx.io.out(t("cli.local.update.autoUpdate", { state: p.reason ?? t("cli.local.update.unsupported") }));
    return;
  }
  if (p.sourceSet === false) ctx.io.out(t("cli.local.update.autoUpdate", { state: noSourceText(t) }));
  else ctx.io.out(t(p.auto ? "cli.local.update.sourceAuto" : "cli.local.update.sourceManual", { source: p.source }));
  if (p.available)
    ctx.io.out(
      t("cli.local.update.found", {
        version: p.available.release ?? p.available.version,
        note: p.requested ? t("cli.local.update.foundRequested") : p.state === "waiting" ? t("cli.local.update.foundWaiting") : "",
      }),
    );
  else if (p.checkedAt) ctx.io.out(t("cli.local.update.checkedAt", { at: when(p.checkedAt) }));
  if (p.error) ctx.io.out(t("cli.local.update.lastError", { error: p.error, retry: p.nextAt ? t("cli.local.update.retryAt", { at: when(p.nextAt) }) : "" }));
  lastUpdateLines(ctx, p.last, p.pending);
}

/** This Daisy's auto-update status (P5-06 / D-34; update/package.ts nodeAutoUpdate), from the catalog's node. */
function autoUpdateOf(catalog: any): any {
  return (catalog?.nodes ?? []).map((n: any) => n?.capabilities?.runner?.autoUpdate).find(Boolean) ?? null;
}

function autoUpdateLine(s: any): string {
  const p = { target: s.target ?? "", error: s.error ?? "" };
  switch (s.state) {
    case "disabled":
    case "no-source":
    case "current":
    case "pending":
    case "available":
    case "failed":
      return t.dynamic(`cli.status.autoUpdate.${s.state}`, p);
    case "unsupported":
      return s.reason ?? t("cli.status.autoUpdate.unsupported");
  }
  return String(s.state);
}

async function updateNow(ctx: Ctx, d: Daisy): Promise<number> {
  try {
    await callRoute(d, ROUTES.updateRestart, { body: { mode: "now" } });
    ctx.io.out(t("cli.local.update.nowNothingRunning"));
    return 0;
  } catch (e: any) {
    if (e?.code !== "restart_interrupts") throw e;
    const list: any[] = e.data?.interrupts ?? [];
    ctx.io.out(t("cli.local.update.nowInterrupts"));
    for (const b of list) ctx.io.out(t("cli.local.update.nowItem", { title: b.session?.title ?? b.sessionId ?? b.id ?? "?", kind: b.kind }));
    const ans = (await ctx.io.readLine(t("cli.local.update.nowConfirm"))).trim();
    if (ans !== "yes") {
      ctx.io.out(t("cli.local.update.nowDeclined"));
      return 1;
    }
    await callRoute(d, ROUTES.updateRestart, { body: { mode: "now", confirm: e.data?.confirm } });
    ctx.io.out(t("cli.local.update.nowRestarting"));
    return 0;
  }
}

// ── doctor ───────────────────────────────────────────────────────────────

const doctorCmd: LocalCommand = {
  spec: { flags: { "--json": "bool" } },
  run: (ctx, a) => doctor(ctx, a.flags["--json"] === true),
};

// ── autostart ────────────────────────────────────────────────────────────

const autostart: LocalCommand = {
  spec: { flags: {}, args: ["on|off"] },
  async run(ctx, a) {
    const what = a.args[0];
    if (what !== undefined && what !== "on" && what !== "off")
      throw usageError(t("cli.local.autostart.badArg", { value: what }), t("cli.local.autostart.badArgFix"));
    if (what === "on") {
      const st = await autostartOn(ctx);
      const by = st.manager === "launchd" ? "launchd" : st.manager === "windows-run" ? t("cli.local.autostart.byWindows") : "systemd";
      ctx.io.out(
        t(
          st.manager === "launchd"
            ? "cli.local.autostart.onLaunchd"
            : st.manager === "windows-run"
              ? "cli.local.autostart.onWindows"
              : "cli.local.autostart.onSystemd",
          { unit: st.unit, file: st.file },
        ),
      );
      if (st.linger === false) ctx.io.out(`! ${lingerHint()}`);
      const rt = await runningDaisy(ctx);
      if (rt && !(st.active && st.mainPid === rt.pid))
        ctx.io.out(
          t(st.manager === "systemd" ? "cli.local.autostart.handOverBoot" : "cli.local.autostart.handOverLogin", {
            by,
            keychain: st.manager === "launchd" ? t("cli.local.autostart.keychain") : "",
          }),
        );
      else if (!rt) ctx.io.out(t("cli.local.autostart.notRunning", { by }));
      return 0;
    }
    if (what === "off") {
      if (ctx.io.platform !== "linux") {
        const s = await autostartSupport(ctx.io);
        if (!s.ok) throw new CliError(s.why, s.fix);
      }
      const st = await managed(ctx);
      const had = await autostartOff(ctx);
      if (!had) ctx.io.out(t("cli.local.autostart.wasOff"));
      else
        ctx.io.out(
          t("cli.local.autostart.off", {
            unit: st?.unit ?? t("cli.local.autostart.unitFallback"),
            still: st?.active ? t("cli.local.autostart.stillRunning", { manager: st.manager }) : "",
          }),
        );
      return 0;
    }
    const s = await autostartSupport(ctx.io);
    if (!s.ok) {
      ctx.io.out(t("cli.local.autostart.state", { state: s.why }));
      return 0;
    }
    const st = await autostartState(ctx);
    ctx.io.out(t("cli.local.autostart.state", { state: autostartLine(ctx, st) }));
    if (st.installed) {
      const labels = [t("cli.local.autostart.row.plist"), t("cli.local.autostart.row.unitFile")];
      ctx.io.out(row(labels, labels[st.manager === "launchd" ? 0 : 1]!, st.file));
    }
    if (st.installed && st.linger === false) ctx.io.out(`! ${lingerHint()}`);
    if (st.installed && st.manager === "launchd") ctx.io.out(launchdHint());
    return 0;
  },
};

// ── uninstall ────────────────────────────────────────────────────────────

/** How to delete the data directory by hand, in this system's shell. */
const removeDataHint = (platform: NodeJS.Platform, dir: string) =>
  t(platform === "win32" ? "cli.local.uninstall.removeWindows" : "cli.local.uninstall.removePosix", { dir });

const uninstall: LocalCommand = {
  helpParams: () => ({ package: PACKAGE_NAME }),
  spec: { flags: { "--yes": "bool" } },
  async run(ctx, a) {
    if (!a.flags["--yes"]) {
      const ans = (await ctx.io.readLine(t("cli.local.uninstall.confirm", { dataDir: ctx.dataDir }))).trim();
      if (ans !== "yes") {
        ctx.io.out(t("cli.local.uninstall.nothingChanged"));
        return 1;
      }
    }
    const hooks = autostartHooks(ctx.io.platform);
    const r = await stopDaisy(ctx);
    ctx.io.out(r.was === "stopped" ? t("cli.local.uninstall.stopped", { pid: r.pid ?? "?" }) : t("cli.local.uninstall.notRunning"));
    // What a killed Daisy left running (harness CLIs, background commands — C-4).
    if (ctx.io.platform !== "win32") {
      const swept = await sweepOrphans(join(ctx.dataDir, "process-groups.json")).catch(() => []);
      if (swept.length) ctx.io.out(t("cli.local.uninstall.swept", { n: swept.length }));
    }
    if (hooks) {
      const had = await hooks.remove(ctx);
      ctx.io.out(
        had
          ? t("cli.local.uninstall.autostartRemoved", { name: hooks.name })
          : hooks.implemented
            ? t("cli.local.uninstall.noAutostart")
            : t("cli.local.uninstall.nothingToRemove", { name: hooks.name }),
      );
    }
    // Verify (I-3): nothing left to run, nothing left to start it.
    const left: string[] = [];
    const f = locate(ctx.dataDir);
    if (f.state === "running") left.push(t("cli.local.uninstall.processLeft", { pid: f.rt.pid }));
    if (hooks) left.push(...(await hooks.leftovers(ctx)));
    if (left.length)
      throw new CliError(t("cli.local.uninstall.notClean", { left: left.join(t("cli.list.separator")) }), t("cli.local.uninstall.notCleanFix"));
    ctx.io.out("");
    ctx.io.out(t("cli.local.uninstall.dataKept", { dir: ctx.dataDir, missing: existsSync(ctx.dataDir) ? "" : t("cli.local.uninstall.dataMissing") }));
    ctx.io.out(t("cli.local.uninstall.dataHint", { remove: removeDataHint(ctx.io.platform, ctx.dataDir) }));
    // This install's own prefix: another install under another prefix is left alone.
    ctx.io.out(t("cli.local.uninstall.last", { uninstall: uninstallCommand(CODE_ROOT, ctx.io.platform) }));
    return 0;
  },
};

// ── watch (P2-03) ────────────────────────────────────────────────────────

const watch: LocalCommand = {
  helpParams: () => WATCH_HELP_PARAMS,
  spec: {
    flags: { "--after": "value", "--cursor-file": "value", "--wait": "value", "--max": "value" },
  },
  run: watchEvents,
};

export const LOCAL: Record<string, LocalCommand> = {
  start,
  stop,
  status,
  open,
  update,
  doctor: doctorCmd,
  autostart,
  uninstall,
  watch,
};

export async function runLocal(name: string, argv: string[], ctx: Ctx): Promise<number> {
  const c = LOCAL[name]!;
  const a = parseLocal(name, argv, c.spec);
  if (a.help) {
    ctx.io.out(localHelp(name));
    return 0;
  }
  return c.run(ctx, a);
}

export function localHelp(name: string): string {
  const c = LOCAL[name]!;
  const key = (part: string) => `cli.local.${name}.${part}`;
  const params = c.helpParams?.() ?? {};
  const usage = t.dynamic(key("usage"), params);
  const help = t.dynamic(key("help"), params);
  return [t("cli.help.localUsage", { usage }), "", t.dynamic(key("summary")), "", help, "", t("cli.help.localCommon")].join("\n");
}
