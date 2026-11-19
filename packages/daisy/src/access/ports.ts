/**
 * P1-03 (D-30, ADR-102 C4 + D1): which port each face listens on.
 *
 *   preferred = base + (uid mod 390)
 *     local face     29200 + (uid mod 390)  → 29200–29589
 *     outside face   29600 + (uid mod 390)  → 29600–29989
 *
 * (Linux uid 1000 → 29420 / 29820; macOS uid 501 → 29311 / 29711.) The
 * whole range is unassigned at IANA and below every system's ephemeral
 * range, so on a shared host each account gets its own port without
 * anyone choosing one.
 *
 * - A port the owner gave (DAISY_PORT, `daisy start --port`, runner.json
 *   `port` (P6-11), the outside face's setting) is used as given; taken → start-up fails, never a
 *   silent switch. Wherever it is given it is an integer 1024–65535
 *   (P6-13, contracts/start-files.ts `portOk`).
 * - Otherwise the remembered port (config.json), else the preferred one.
 *   Taken → the next free port up the 390-port range (wrapping); on a
 *   first start the one found is remembered, later it is only for this
 *   run (`moved`), and the log and `daisy status` say so.
 * - The port in use goes into the runtime file (runtime.json, 0600), where
 *   the command line reads it — it never guesses.
 */
import { ownerT } from "../platform/language.ts";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { readAccessConfig, writeAccessConfig } from "./config.ts";
import { withSettings } from "../platform/settings.ts";
import { portOk, portRule } from "../../../contracts/src/start-files.ts";

export type Face = "local" | "external";
export const PORT_BASE: Record<Face, number> = { local: 29200, external: 29600 };
export const PORT_SPAN = 390;
export type PortSource = "derived" | "remembered" | "given" | "moved";

/**
 * The system account's uid. Windows has none (userInfo().uid is -1): a
 * stable number from the account's domain and name (P5-05), so two
 * accounts of one machine derive different ports.
 */
export function systemUid(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): number {
  if (platform === "win32") return windowsAccountNumber(`${env.USERDOMAIN ?? ""}\\${safeUser()}`);
  const uid = process.getuid?.() ?? userInfo().uid;
  return Number.isInteger(uid) && uid >= 0 ? uid : 0;
}
const safeUser = () => {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME ?? "";
  }
};
/** DOMAIN\\user (case-insensitive, as Windows treats it) → a non-negative 31-bit number. */
export const windowsAccountNumber = (account: string) =>
  createHash("sha256").update(account.toLowerCase()).digest().readUInt32BE(0) & 0x7fffffff;

export const derivedPort = (face: Face, uid: number = systemUid()) =>
  PORT_BASE[face] + (((uid % PORT_SPAN) + PORT_SPAN) % PORT_SPAN);

/** The candidates after `start`, inside the face's range, wrapping. */
export function* portsFrom(face: Face, start: number) {
  const base = PORT_BASE[face];
  const first =
    start >= base && start < base + PORT_SPAN ? start - base : 0;
  for (let i = 0; i < PORT_SPAN; i++)
    yield base + ((first + i) % PORT_SPAN);
}

const inUse = (e: any) => e?.code === "EADDRINUSE" || e?.code === "EACCES";

/**
 * Bind `face` with `listen(port)` (which must reject with EADDRINUSE when
 * the port is taken) following the rules above. Returns the port and
 * where it came from; remembers a first start's choice.
 */
export async function bindPort(
  face: Face,
  o: { dataDir: string; given?: number; uid?: number },
  listen: (port: number) => Promise<void>,
): Promise<{ port: number; source: PortSource; preferred: number }> {
  const preferred = derivedPort(face, o.uid);
  if (o.given) {
    try {
      await listen(o.given);
    } catch (e) {
      if (inUse(e))
        throw Object.assign(
          new Error(ownerT()("server-access.port.givenInUse", { port: o.given })),
          { code: "EADDRINUSE" },
        );
      throw e;
    }
    return { port: o.given, source: "given", preferred };
  }
  const remembered = readAccessConfig(o.dataDir).ports[face];
  const start = remembered ?? preferred;
  for (const port of portsFrom(face, start)) {
    try {
      await listen(port);
    } catch (e) {
      if (inUse(e)) continue;
      throw e;
    }
    const source: PortSource =
      port === start ? (remembered ? "remembered" : "derived") : "moved";
    if (!remembered)
      writeAccessConfig(o.dataDir, (c) => ({
        ...c,
        ports: { ...c.ports, [face]: port },
      }));
    return { port, source, preferred };
  }
  throw Object.assign(
    new Error(ownerT()("server-access.port.noneFree", { from: PORT_BASE[face], to: PORT_BASE[face] + PORT_SPAN - 1 })),
    { code: "EADDRINUSE" },
  );
}

/**
 * P6-13: the local port the environment gives (DAISY_PORT, else PORT;
 * runner.json `port` is in DAISY_PORT by then, already checked). `bad`
 * when one is set but is not an integer 1024–65535: the start refuses it
 * rather than binding something else.
 */
export function givenLocalPort(env: Record<string, string | undefined>): { port?: number; bad?: string } {
  const name = env.DAISY_PORT ? "DAISY_PORT" : env.PORT ? "PORT" : null;
  if (!name) return {};
  const raw = env[name]!;
  const n = Number(raw);
  // "0" has always meant "not given" (the rule picks one), as before P6-13.
  if (raw.trim() === "0") return {};
  if (portOk(n)) return { port: n };
  return { bad: ownerT()("server-access.port.badEnv", { setting: `${name}=${raw.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 40)}`, rule: portRule(ownerT()) }) };
}

/**
 * P6-11: the port the local face would try first if Daisy started now —
 * the rule above without binding anything (doctor, scripts/doctor.ts):
 * given (DAISY_PORT, else PORT, else runner.json `port`), else the
 * remembered one, else derived from the uid.
 */
export function expectedLocalPort(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
  uid?: number,
): { port: number; source: "given" | "remembered" | "derived" } {
  const e = withSettings(dataDir, env);
  const given = givenLocalPort(e).port;
  if (given !== undefined) return { port: given, source: "given" };
  const remembered = readAccessConfig(dataDir).ports.local;
  if (remembered) return { port: remembered, source: "remembered" };
  return { port: derivedPort("local", uid), source: "derived" };
}
