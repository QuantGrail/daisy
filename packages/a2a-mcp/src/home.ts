/**
 * P4-09 (ADR-128 §3): where the standalone A2A MCP keeps its own things —
 * its Ed25519 identity key, its address book, its calls and the TLS
 * certificates it pinned — a small directory of files, only for the
 * account that runs it:
 *
 *   --home <dir>  >  DAISY_MCP_HOME  >  the system's convention:
 *     macOS    ~/Library/Application Support/Daisy MCP
 *     Linux    $XDG_CONFIG_HOME/daisy-mcp, else ~/.config/daisy-mcp
 *     Windows  %APPDATA%\Daisy MCP, else ~\AppData\Roaming\Daisy MCP
 *
 * Never Daisy's own data directory (a Daisy and this MCP on one machine are
 * two identities). The directory is 0700, every file 0600, written
 * whole (a temporary file renamed over the old one), and a file that group
 * or others may read — or that is a link, or not this account's — is
 * refused instead of used (S-3).
 */
import { KeyedError } from "../../contracts/src/i18n-process.ts";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { randomBytes } from "node:crypto";
import { MCP_COMMAND_NAME, MCP_NAME } from "../../contracts/src/names.ts";

export const HOME_ENV = "DAISY_MCP_HOME";
const DIR_NAME = { posix: MCP_COMMAND_NAME, mac: MCP_NAME, windows: MCP_NAME } as const;

/** The home directory, as the module comment says. */
export function homeDir(
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (flag) return resolve(flag);
  if (env[HOME_ENV]) return resolve(env[HOME_ENV]!);
  if (platform === "win32") return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), DIR_NAME.windows);
  if (platform === "darwin") return join(home, "Library", "Application Support", DIR_NAME.mac);
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && xdg.startsWith("/") ? xdg : join(home, ".config"), DIR_NAME.posix);
}

const POSIX = process.platform !== "win32";

/** A file under the home that is not safe to use (loose permissions, a link, another owner). */
export class HomeError extends KeyedError {}

export class Home {
  constructor(readonly dir: string) {}

  /** Make the directory (0700) and the subdirectories; tighten a loose one we own. */
  ensure(): this {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.dir, "calls"), { recursive: true, mode: 0o700 });
    if (POSIX) {
      for (const d of [this.dir, join(this.dir, "calls")]) {
        const st = lstatSync(d);
        if (st.isSymbolicLink() || !st.isDirectory()) throw new HomeError("mcp.home.notDir", { path: d });
        if (process.getuid && st.uid !== process.getuid()) throw new HomeError("mcp.home.dirOwner", { path: d });
        if ((st.mode & 0o077) !== 0) chmodSync(d, 0o700);
      }
    }
    return this;
  }

  path(...parts: string[]) {
    return join(this.dir, ...parts);
  }

  /**
   * A file's text, or null when there is none. Refused: a link, not a
   * regular file, another account's, or readable / writable by others.
   */
  read(name: string): string | null {
    const p = this.path(name);
    let fd: number;
    try {
      const pre = lstatSync(p);
      if (pre.isSymbolicLink() || !pre.isFile()) throw new HomeError("mcp.home.link", { path: p });
      fd = openSync(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      if (e instanceof HomeError) throw e;
      throw new HomeError("mcp.home.unreadable", { path: p, why: String(e?.code ?? e?.message ?? e) });
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new HomeError("mcp.home.notFile", { path: p });
      if (POSIX) {
        if (process.getuid && st.uid !== process.getuid()) throw new HomeError("mcp.home.fileOwner", { path: p });
        if ((st.mode & 0o077) !== 0)
          throw new HomeError("mcp.home.loose", { path: p, mode: (st.mode & 0o777).toString(8) });
      }
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }

  readJson<T>(name: string, fallback: T): T {
    const t = this.read(name);
    if (t === null) return fallback;
    try {
      return JSON.parse(t) as T;
    } catch {
      throw new HomeError("mcp.home.notJson", { path: this.path(name) });
    }
  }

  /** Write a file whole, 0600 (a temporary file renamed over the old one). */
  write(name: string, text: string) {
    const p = this.path(name);
    const tmp = `${p}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    try {
      if (POSIX) chmodSync(tmp, 0o600);
      renameSync(tmp, p);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  writeJson(name: string, v: unknown) {
    this.write(name, JSON.stringify(v, null, 2) + "\n");
  }

  /** Create a file only if it is not there yet (the identity key): false when it was. */
  create(name: string, text: string): boolean {
    try {
      writeFileSync(this.path(name), text, { mode: 0o600, flag: "wx" });
      return true;
    } catch (e: any) {
      if (e?.code === "EEXIST") return false;
      throw e;
    }
  }

  list(dir: string): string[] {
    try {
      return readdirSync(this.path(dir));
    } catch {
      return [];
    }
  }

  remove(name: string) {
    rmSync(this.path(name), { force: true });
  }
}
