/**
 * N-9 (C-1 device acceptance): what `claude auth status --json` said, in
 * one of a few kinds, each with its own message. Before this every failure
 * of the check — a timeout, a non-zero exit, output that is not JSON, a
 * keychain the process may not read, a CLI that would not start — read
 * 「未登录或登录已过期」, and the real cause was lost.
 *
 * Used by the turn preflight (claude.ts `start`), the official terminal
 * (turns/terminal.ts) and `daisy doctor` (cli/local/doctor.ts), so the three
 * say the same thing about the same answer. Nothing here prints account
 * details: the excerpt shown to the person goes through the central
 * redaction (observe/redact.ts) and has e-mail addresses masked too.
 */
import { turnT } from "./model-switch.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MASK, redact } from "../observe/redact.ts";

/** One run of `claude auth status --json`, however it ended. */
export interface AuthProbe {
  /** Exit code (null: killed / never started). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Killed after the time allowed. */
  timedOut?: boolean;
  /** The program could not be started (ENOENT, EACCES, …): its error code. */
  spawnError?: string;
}

export type AuthVerdict =
  | { kind: "ok"; plan?: string }
  /** Logged in, but with an API key or another provider (not a subscription). */
  | { kind: "not-subscription" }
  | { kind: "not-logged-in" }
  /**
   * macOS: Claude says not logged in although this identity's directory
   * records an account — the credential in the keychain could not be read.
   */
  | { kind: "keychain-suspect" }
  | { kind: "timeout" }
  | { kind: "missing"; code: string }
  | { kind: "keychain" }
  | { kind: "failed"; excerpt: string };

/** What a keychain the process may not use looks like in the CLI's output. */
const KEYCHAIN =
  /keychain|SecKeychain|errSec|\bsecurity\b[^\n]*(?:fail|error|denied|not allowed|-25\d{3})|user interaction is not allowed|-2530[0-9]|-25293/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Redacted (central layer) and with e-mail addresses masked. */
export function scrub(text: string): string {
  return redact(String(text ?? "")).replace(EMAIL, MASK);
}
/** A short, scrubbed excerpt of the CLI's output for a message. */
export function excerpt(text: string, max = 160): string {
  const one = scrub(text).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * Does this managed identity's directory record a signed-in account?
 * (`.claude.json` keeps `oauthAccount` after a login; `auth logout` clears
 * it.) Only the presence is read — nothing of the account.
 */
export function recordsAccount(configDir: string | undefined): boolean {
  if (!configDir) return false;
  try {
    const f = join(configDir, ".claude.json");
    if (!existsSync(f)) return false;
    const j = JSON.parse(readFileSync(f, "utf8"));
    return !!j && typeof j === "object" && !!j.oauthAccount;
  } catch {
    return false;
  }
}

export function classifyClaudeAuth(
  p: AuthProbe,
  o: { platform?: NodeJS.Platform; configDir?: string } = {},
): AuthVerdict {
  if (p.spawnError) return { kind: "missing", code: p.spawnError };
  if (p.timedOut) return { kind: "timeout" };
  // A JSON answer is the CLI's own verdict, whatever the exit code (it
  // exits non-zero when not logged in).
  let auth: any;
  try {
    auth = JSON.parse(p.stdout);
  } catch {}
  if (auth && typeof auth === "object" && typeof auth.loggedIn === "boolean") {
    if (!auth.loggedIn) {
      if (
        (o.platform ?? process.platform) === "darwin" &&
        (KEYCHAIN.test(p.stderr) || recordsAccount(o.configDir))
      )
        return { kind: "keychain-suspect" };
      return { kind: "not-logged-in" };
    }
    if (
      /api[_-]?key/i.test(auth.authMethod || "") ||
      (auth.apiProvider && auth.apiProvider !== "firstParty")
    )
      return { kind: "not-subscription" };
    return {
      kind: "ok",
      ...(typeof auth.subscriptionType === "string"
        ? { plan: auth.subscriptionType.slice(0, 40) }
        : {}),
    };
  }
  if (p.code !== 0 && KEYCHAIN.test(`${p.stderr}\n${p.stdout}`))
    return { kind: "keychain" };
  const tail = excerpt(p.stderr || p.stdout);
  return {
    kind: "failed",
    excerpt:
      p.code === 0
        ? tail
          ? turnT()("server-harness.claudeAuth.notJsonTail", { tail })
          : turnT()("server-harness.claudeAuth.notJson")
        : tail
          ? turnT()("server-harness.claudeAuth.exitTail", { code: String(p.code ?? "-"), tail })
          : turnT()("server-harness.claudeAuth.exit", { code: String(p.code ?? "-") }),
  };
}

/** Worth one more try after a short wait (ADR-133). */
export const transientAuth = (v: AuthVerdict) =>
  ["timeout", "keychain", "keychain-suspect", "failed"].includes(v.kind);

// P5-04 (ADR-140): with `autostart on` the start goes through launchd,
// which runs Daisy in the owner's login session — the keychain is there.
// The texts are said in the owner's language when read (getters).
export const AUTH_MESSAGES = {
  get notLoggedIn() {
    return turnT()("server-harness.claudeAuth.notLoggedIn");
  },
  get notSubscription() {
    return turnT()("server-harness.claudeAuth.notSubscription");
  },
  get timeout() {
    return turnT()("server-harness.claudeAuth.timeout");
  },
  get keychain() {
    return turnT()("server-harness.claudeAuth.keychain");
  },
  get keychainSuspect() {
    return turnT()("server-harness.claudeAuth.keychainSuspect");
  },
};

/** The person-facing sentence for a verdict that is not `ok`. */
export function claudeAuthMessage(v: AuthVerdict): string {
  switch (v.kind) {
    case "ok":
      return "";
    case "not-subscription":
      return AUTH_MESSAGES.notSubscription;
    case "not-logged-in":
      return AUTH_MESSAGES.notLoggedIn;
    case "keychain-suspect":
      return AUTH_MESSAGES.keychainSuspect;
    case "timeout":
      return AUTH_MESSAGES.timeout;
    case "keychain":
      return AUTH_MESSAGES.keychain;
    case "missing":
      return turnT()("server-harness.claudeAuth.missing", { code: String(v.code) });
    case "failed":
      return turnT()("server-harness.claudeAuth.failed", { excerpt: v.excerpt });
  }
}

/** The daemon-log line for a failed check: full stderr, redacted. */
export function authLogLine(who: string, p: AuthProbe, v: AuthVerdict) {
  return `Claude sign-in check (${who}): ${v.kind}; exit code ${p.code ?? "none"}${p.timedOut ? " (killed on timeout)" : ""}${p.spawnError ? `; spawn failed ${p.spawnError}` : ""}; stderr: ${scrub(p.stderr).slice(0, 4000) || "(empty)"}`;
}

/** Retry timing (tests shorten it). */
export const AUTH_TIMING = { timeoutMs: 10_000, retryMs: 2_000 };

/**
 * Run the check, and once more after `AUTH_TIMING.retryMs` when the first
 * answer may be passing (a timeout, a keychain error, an unexpected exit).
 * Nothing is remembered between calls: every launch asks again.
 */
export async function checkClaudeAuth(
  run: (timeoutMs: number) => Promise<AuthProbe>,
  o: {
    platform?: NodeJS.Platform;
    configDir?: string;
    sleep?: (ms: number) => Promise<void>;
    onFailure?: (p: AuthProbe, v: AuthVerdict, attempt: number) => void;
  } = {},
): Promise<AuthVerdict> {
  const sleep =
    o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let v: AuthVerdict = { kind: "timeout" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const p = await run(AUTH_TIMING.timeoutMs);
    v = classifyClaudeAuth(p, o);
    if (v.kind === "ok") return v;
    o.onFailure?.(p, v, attempt);
    if (!transientAuth(v) || attempt === 2) return v;
    await sleep(AUTH_TIMING.retryMs);
  }
  return v;
}

/** An execFile error / result as a probe. */
export function probeOf(
  e: any,
  out?: { stdout?: unknown; stderr?: unknown },
): AuthProbe {
  const stdout = String(out?.stdout ?? e?.stdout ?? "");
  const stderr = String(out?.stderr ?? e?.stderr ?? "");
  if (!e) return { code: 0, stdout, stderr };
  if (typeof e.code === "string")
    return { code: null, stdout, stderr, spawnError: e.code };
  return {
    code: typeof e.code === "number" ? e.code : null,
    stdout,
    stderr,
    ...(e.killed ? { timedOut: true } : {}),
  };
}
