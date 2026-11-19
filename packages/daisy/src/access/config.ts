/**
 * P1-03: the access settings this Daisy keeps in its data directory
 * (ADR-102: `config.json`, 0600) — the ports it settled on (D-30), the
 * outside face (D-31) and the passcode mode (D-09). Written whole, through
 * a temporary file, so a crash never leaves half a file.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface ExternalConfig {
  enabled: boolean;
  host: string;
  port?: number;
  tls: boolean;
  allow: { terminal: boolean; shell: boolean; browse: boolean };
}
export type PasscodeMode = "auto" | "on" | "off";
export interface AccessConfig {
  ports: { local?: number; external?: number };
  external: ExternalConfig;
  passcode: PasscodeMode;
}

export const EXTERNAL_OFF: ExternalConfig = {
  enabled: false,
  host: "",
  tls: true,
  allow: { terminal: false, shell: false, browse: false },
};

const file = (dataDir: string) => join(dataDir, "config.json");

/** The settings (defaults where absent or unreadable — never more open). */
export function readAccessConfig(dataDir: string): AccessConfig {
  let raw: any = {};
  try {
    if (existsSync(file(dataDir)))
      raw = JSON.parse(readFileSync(file(dataDir), "utf8")) || {};
  } catch {
    raw = {};
  }
  const e = raw.external || {};
  const port = (v: unknown) =>
    Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536
      ? (v as number)
      : undefined;
  return {
    ports: { local: port(raw.ports?.local), external: port(raw.ports?.external) },
    external: {
      enabled: e.enabled === true && typeof e.host === "string" && !!e.host,
      host: typeof e.host === "string" ? e.host : "",
      ...(port(e.port) ? { port: port(e.port) } : {}),
      tls: e.tls !== false,
      allow: {
        terminal: e.allow?.terminal === true,
        shell: e.allow?.shell === true,
        browse: e.allow?.browse === true,
      },
    },
    passcode: ["auto", "on", "off"].includes(raw.passcode) ? raw.passcode : "auto",
  };
}

/** Merge `patch` into the settings on disk (other keys kept). */
export function writeAccessConfig(
  dataDir: string,
  patch: (c: AccessConfig) => AccessConfig,
): AccessConfig {
  let raw: any = {};
  try {
    if (existsSync(file(dataDir)))
      raw = JSON.parse(readFileSync(file(dataDir), "utf8")) || {};
  } catch {
    raw = {};
  }
  const next = patch(readAccessConfig(dataDir));
  const out = { ...raw, ...next };
  const tmp = file(dataDir) + `.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file(dataDir));
  return next;
}

/**
 * P2-01: another section of config.json (the external issuer, ADR-113),
 * read as it was written — the caller validates it. Absent or unreadable:
 * undefined (never more open).
 */
export function readConfigSection(dataDir: string, key: string): unknown {
  try {
    if (!existsSync(file(dataDir))) return undefined;
    const raw = JSON.parse(readFileSync(file(dataDir), "utf8"));
    return raw && typeof raw === "object" ? raw[key] : undefined;
  } catch {
    return undefined;
  }
}

/** Set (or, `undefined`, remove) one section of config.json; the rest is kept. */
export function writeConfigSection(dataDir: string, key: string, value: unknown): void {
  let raw: any = {};
  try {
    if (existsSync(file(dataDir)))
      raw = JSON.parse(readFileSync(file(dataDir), "utf8")) || {};
  } catch {
    raw = {};
  }
  if (value === undefined) delete raw[key];
  else raw[key] = value;
  const tmp = file(dataDir) + `.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file(dataDir));
}
