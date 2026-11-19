/**
 * P1-07 (3.7 「每条错误信息说明出了什么事、怎么解决」): every failure the
 * command reports is a CliError — what happened, and what to do about it.
 * Never a credential, PIN, grant or one-time code in either (S-1).
 */
import { t } from "./lang.ts";
export class CliError extends Error {
  constructor(
    /** What happened. */
    message: string,
    /** How to solve it. */
    public fix: string,
    /** 1: failed; 2: the command was written wrong; 3: Daisy is not running. */
    public exitCode = 1,
    /** The server's machine-readable code, when the error came from it. */
    public code?: string,
  ) {
    super(message);
  }
}

export const usageError = (message: string, fix: string) =>
  new CliError(message, fix, 2);

export function formatError(e: CliError): string {
  return `✗ ${e.message}\n  ${t("cli.error.fix", { fix: e.fix })}`;
}

/** Not running: the one answer every command that needs Daisy gives. */
export const notRunning = (why: string) =>
  new CliError(t("cli.error.notRunning", { why }), t("cli.error.notRunningFix"), 3, "not_running");
