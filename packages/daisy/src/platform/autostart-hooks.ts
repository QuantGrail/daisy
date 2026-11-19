/**
 * P5-06 (ADR-145): what `daisy uninstall` needs of each system's start at
 * boot / login — one small interface, one implementation per system, so
 * uninstalling is the same command everywhere (D-41 ④) and I-3 (「没有残留
 * 的后台进程和自启动项」) is checked the same way everywhere.
 *
 * - Linux: the systemd user unit (autostart.ts, P1-09).
 * - macOS: the LaunchAgent (autostart.ts / launchd.ts, P5-04).
 * - Windows: the current user's Run entry (P5-05, ADR-141,
 *   windows/autostart.ts) and the helper's supervisor it starts.
 */
import { ownerT } from "./language.ts";
import { COMMAND_NAME } from "../../../contracts/src/names.ts";
import { autostartOff, autostartState, runNameFor, type AutostartHost } from "./autostart.ts";
import { commandLines, readProcTable } from "./proc-table.ts";
import { splitCommandLine } from "./windows/cmdline.ts";
import { guiDomain } from "./launchd.ts";

type Ctx = { io: AutostartHost; dataDir: string };

export interface AutostartHooks {
  /** The mechanism, as the owner reads it. */
  readonly name: string;
  /**
   * Stop it from starting Daisy again and delete what it was made of
   * (unit, plist, scheduled task …). A Daisy it runs now is not stopped
   * here (`daisy stop` does that first). True: there was something.
   */
  remove(ctx: Ctx): Promise<boolean>;
  /** What would still start Daisy, or still runs it (empty: nothing). */
  leftovers(ctx: Ctx): Promise<string[]>;
  /** The same by hand, for when `daisy` itself is already uninstalled (docs, messages). */
  manualRemoval(ctx: Ctx): string;
  /** False: not built for this system yet (the stub). */
  readonly implemented: boolean;
}

const managerLeftovers = async (ctx: Ctx): Promise<string[]> => {
  const st = await autostartState(ctx);
  const left: string[] = [];
  const t = ownerT();
  if (st.installed || st.enabled) left.push(t("server-platform.hooks.entryLeft", { unit: st.unit, file: st.file }));
  if (st.active) left.push(t("server-platform.hooks.stillRunning", { manager: st.manager, unit: st.unit }));
  else if (st.manager === "launchd" && st.loaded)
    left.push(t("server-platform.hooks.stillLoaded", { unit: st.unit, target: `${guiDomain()}/${st.unit}` }));
  return left;
};

export const systemdHooks: AutostartHooks = {
  get name() {
    return ownerT()("server-platform.hooks.systemdName");
  },
  implemented: true,
  remove: (ctx) => autostartOff(ctx),
  leftovers: managerLeftovers,
  manualRemoval: () =>
    `systemctl --user disable --now ${COMMAND_NAME}.service && rm ~/.config/systemd/user/${COMMAND_NAME}.service && systemctl --user daemon-reload`,
};

export const launchdHooks: AutostartHooks = {
  get name() {
    return ownerT()("server-platform.hooks.launchdName");
  },
  implemented: true,
  remove: (ctx) => autostartOff(ctx),
  leftovers: managerLeftovers,
  manualRemoval: () =>
    `launchctl bootout gui/$(id -u)/ai.${COMMAND_NAME}.${COMMAND_NAME}; rm ~/Library/LaunchAgents/ai.${COMMAND_NAME}.${COMMAND_NAME}.plist`,
};

/**
 * Windows (P5-05, ADR-141): the HKCU Run value, and the helper's
 * `supervise` for this data directory (it would start Daisy again).
 */
export const windowsHooks: AutostartHooks = {
  get name() {
    return ownerT()("server-platform.hooks.windowsName");
  },
  implemented: true,
  remove: (ctx) => autostartOff(ctx),
  leftovers: async (ctx) => {
    const left = await managerLeftovers(ctx);
    if (process.platform === "win32") {
      const name = runNameFor(ctx);
      const table = readProcTable();
      const helpers = [...table.values()].filter((r) => /^daisy-win(\.exe)?$/i.test(r.comm)).map((r) => r.pid);
      for (const [pid, cmd] of commandLines(helpers))
        if (/\bsupervise\b/.test(cmd) && supervisorName(cmd) === name)
          left.push(ownerT()("server-platform.hooks.supervisorRunning", { pid, name }));
    }
    return left;
  },
  manualRemoval: (ctx) =>
    ownerT()("server-platform.hooks.windowsManual", {
      cmd: `Remove-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "${runNameFor(ctx)}"`,
    }),
};

/** The `--name` of a supervise command line. */
export function supervisorName(cmdline: string): string | null {
  const argv = splitCommandLine(cmdline);
  const i = argv.indexOf("--name");
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

export function autostartHooks(platform: NodeJS.Platform): AutostartHooks | null {
  if (platform === "linux") return systemdHooks;
  if (platform === "darwin") return launchdHooks;
  if (platform === "win32") return windowsHooks;
  return null;
}
