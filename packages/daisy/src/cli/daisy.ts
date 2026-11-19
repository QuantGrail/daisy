/**
 * P1-07: finding the running Daisy and talking to it.
 *
 * The command never guesses a port (D-30, ADR-102): it reads the runtime
 * file the process writes (`runtimeFile(dataDir())`, P1-03) for where the
 * local face listens and where the command line's credential is, and
 * sends that credential as `Authorization: Bearer` (ADR-110 §2). It never
 * reads or writes the database: everything goes through the local API.
 */
import { COMMAND_NAME } from "../../../contracts/src/names.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeFile } from "../platform/paths.ts";
import { CliError, notRunning } from "./errors.ts";
import { callRoute, routeOf, ROUTES } from "./routes.ts";
import type { Io } from "./io.ts";
import { t } from "./lang.ts";

export interface Runtime {
  pid: number;
  release: string | null;
  startedAt: number;
  dataDir: string;
  local: { url: string; port: number; source?: string };
  external: { url: string; port: number; tls: boolean } | null;
  cliCredential: string;
  /** P6-11: what was wrong with the start settings when it started (one line each). */
  problems?: string[];
}

export interface Ctx {
  io: Io;
  dataDir: string;
}

export const logsDir = (dataDir: string) => join(dataDir, "logs");
export const logFile = (dataDir: string) => join(logsDir(dataDir), `${COMMAND_NAME}.log`);

export function readRuntime(dataDir: string): Runtime | null {
  try {
    const rt = JSON.parse(readFileSync(runtimeFile(dataDir), "utf8"));
    if (typeof rt?.pid !== "number" || typeof rt?.local?.url !== "string") return null;
    return rt as Runtime;
  } catch {
    return null;
  }
}

/** Whether a process with this id exists (another account's counts too). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

export type Found =
  | { state: "absent" }
  | { state: "stale"; rt: Runtime }
  | { state: "running"; rt: Runtime };

/** The runtime file, and whether its process is still there. */
export function locate(dataDir: string): Found {
  const rt = readRuntime(dataDir);
  if (!rt) return { state: "absent" };
  return pidAlive(rt.pid) ? { state: "running", rt } : { state: "stale", rt };
}

/** GET /api/health (public): is it this Daisy answering, and which release. */
export async function health(
  url: string,
  timeoutMs = 3000,
): Promise<{ ok: boolean; release?: string | null; apiVersion?: number } | null> {
  try {
    const r = await fetch(url + (routeOf(ROUTES.health)?.path ?? "/api/health"), { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return (await r.json()) as any;
  } catch {
    return null;
  }
}

export interface CallOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Return the bytes instead of parsing JSON. */
  binary?: boolean;
  timeoutMs?: number;
}

export interface Reply {
  status: number;
  data: any;
  bytes?: Uint8Array;
  contentType?: string;
}

/** The query string: arrays repeat, objects go as JSON. */
export function queryString(q: Record<string, unknown> | undefined): string {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) p.append(k, String(x));
    else if (v !== null && typeof v === "object") p.append(k, JSON.stringify(v));
    else p.append(k, String(v));
  }
  const s = p.toString();
  return s ? "?" + s : "";
}

/** The running Daisy of this data directory, as the command line. */
export class Daisy {
  constructor(
    readonly rt: Runtime,
    private token: string,
    readonly ctx: Ctx,
  ) {}

  /** Connect, or say what is wrong and how to fix it. */
  static connect(ctx: Ctx): Daisy {
    const found = locate(ctx.dataDir);
    if (found.state === "absent")
      throw notRunning(t("cli.connect.noRuntime", { dir: ctx.dataDir }));
    if (found.state === "stale")
      throw notRunning(t("cli.connect.stale", { pid: found.rt.pid }));
    let token: string;
    try {
      token = readFileSync(found.rt.cliCredential, "utf8").trim();
    } catch (e: any) {
      throw new CliError(
        t("cli.connect.credential", { file: found.rt.cliCredential, why: e?.code ?? t("cli.connect.readFailed") }),
        e?.code === "EACCES" ? t("cli.connect.credentialSameAccount") : t("cli.connect.credentialRestart"),
      );
    }
    return new Daisy(found.rt, token, ctx);
  }

  get url() {
    return this.rt.local.url;
  }

  async call(method: string, path: string, o: CallOptions = {}): Promise<Reply> {
    let r: Response;
    try {
      r = await fetch(this.url + path + queryString(o.query), {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
          // P6-20: the server's messages in the command's language.
          "accept-language": t.lang,
          ...o.headers,
        },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
      });
    } catch (e: any) {
      if (e?.name === "TimeoutError")
        throw new CliError(
          t("cli.call.timeout", { seconds: Math.round((o.timeoutMs ?? 60_000) / 1000), request: `${method} ${path}` }),
          t("cli.call.timeoutFix", { log: logHint(this.ctx.dataDir) }),
        );
      throw new CliError(
        t("cli.call.unreachable", { url: this.url, why: e?.cause?.code ?? e?.message ?? t("cli.call.networkError") }),
        t("cli.call.unreachableFix"),
        3,
        "not_running",
      );
    }
    const contentType = r.headers.get("content-type") ?? "";
    if (r.ok && o.binary) {
      return {
        status: r.status,
        data: null,
        bytes: new Uint8Array(await r.arrayBuffer()),
        contentType,
      };
    }
    const text = await r.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!r.ok) throw apiError(r.status, data, this.ctx.dataDir);
    return { status: r.status, data, contentType };
  }

  /**
   * A PIN grant for one command (local-api.md §6): the PIN from a prompt
   * that does not echo, traded for a grant that lives only in this
   * process's memory and is used once. Never cached, printed or logged.
   */
  async pinGrant(): Promise<string> {
    const pin = await readCredential(this.ctx.io, t("cli.pin.prompt"), "PIN");
    const r = await callRoute(this, ROUTES.pinGrant, { body: { pin } });
    const grant = r.data?.grant;
    if (typeof grant !== "string")
      throw new CliError(t("cli.pin.noGrant"), t("cli.pin.noGrantFix"));
    return grant;
  }
}

/** A credential from the prompt; empty is refused. */
export async function readCredential(io: Io, prompt: string, what: string): Promise<string> {
  let v: string;
  try {
    v = await io.readSecret(prompt);
  } catch (e: any) {
    if (e?.cancelled) throw new CliError(t("cli.input.cancelled"), t("cli.input.cancelledFix"), 130);
    throw new CliError(
      t("cli.input.noStdin", { what }),
      io.stdinTTY ? t("cli.input.noStdinTty") : t("cli.input.noStdinPipe"),
    );
  }
  if (!v) throw new CliError(t("cli.input.empty", { what }), t("cli.input.emptyFix"));
  return v;
}

export function logHint(dataDir: string): string {
  return t("cli.logHint", { file: logFile(dataDir) });
}

/**
 * An error answer → what happened and how to fix it. The server's own
 * message says what happened; the code picks the fix.
 */
export function apiError(status: number, data: any, dataDir: string): CliError {
  const code: string | undefined = typeof data?.code === "string" ? data.code : undefined;
  const msg: string =
    typeof data?.error === "string"
      ? data.error
      : typeof data === "string" && data
        ? data.slice(0, 300)
        : `HTTP ${status}`;
  const details: string[] = Array.isArray(data?.details) ? data.details.map(String) : [];
  const what = details.length ? t("cli.apiError.withDetails", { message: msg, details: details.join(t("cli.list.separator")) }) : msg;
  // P4-11: the server's own 怎么办 when it gives one (an undeclared
  // capability names what to do instead).
  const fix =
    (typeof data?.fix === "string" && data.fix ? data.fix : undefined) ??
    (code && FIX_CODES.has(code) ? t.dynamic(`cli.apiError.fix.${code}`) : undefined) ??
    byStatus(status, dataDir);
  const e = new CliError(what, fix, status === 400 || status === 422 ? 2 : 1, code);
  (e as any).status = status;
  (e as any).data = data;
  return e;
}

/** Codes with their own 怎么办 (`cli.apiError.fix.<code>` in the packs). */
const FIX_CODES = new Set([
  "unauthenticated",
  "channel_not_allowed",
  "insufficient_scope",
  "not_own_session",
  "pin_required",
  "pin_wrong",
  "pin_locked",
  "pin_not_set",
  "pin_invalid",
  "pin_old_required",
  "pin_unavailable",
  "route_not_defined",
  "external_off",
  "restart_unavailable",
  "restart_interrupts",
  "host_not_allowed",
  "cross_site",
  "rate_limited",
  "capability_unsupported",
  "cursor_reset",
]);

function byStatus(status: number, dataDir: string): string {
  if (status === 400 || status === 422) return t("cli.apiError.status.400");
  if (status === 401) return t("cli.apiError.fix.unauthenticated");
  if (status === 403) return t("cli.apiError.status.403");
  if (status === 404) return t("cli.apiError.status.404");
  if (status === 409) return t("cli.apiError.status.409");
  if (status === 413) return t("cli.apiError.status.413");
  if (status === 429) return t("cli.apiError.fix.rate_limited");
  if (status >= 500) return t("cli.apiError.status.500", { log: logHint(dataDir) });
  return t("cli.apiError.status.other");
}
