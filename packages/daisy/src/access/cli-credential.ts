/**
 * P1-03 (5.11 「命令行」, ADR-099 recommendation 4, ADR-110): the command
 * line's local credential — 256 random bits in `keys/cli-credential`,
 * readable only by the owner (0600, S-3). The command line sends it as
 * `Authorization: Bearer`; it is valid on the local face only and is
 * treated as "maybe the owner, maybe the owner's AI": it cannot answer the
 * AI's tool approvals or questions (routes whose channels lack `cli`).
 *
 * Not a signed token: it never leaves this machine, so nothing is gained
 * by a signature, and an opaque string compared by its SHA-256 can be
 * replaced at once (rotate). The server keeps only the digest in memory.
 */
import { ownerT } from "../platform/language.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { readSecretFile } from "./secret-file.ts";
import { ensureKeysDir, exists, writeSecret } from "./keys.ts";
import { registerSecret } from "../observe/redact.ts";

export const CLI_PREFIX = "dcli_";
export const cliCredentialFile = (dataDir: string) =>
  join(dataDir, "keys", "cli-credential");

const digest = (s: string) => createHash("sha256").update(s).digest();

export class CliCredential {
  private hash: Buffer;
  constructor(private dataDir: string) {
    ensureKeysDir(dataDir);
    const file = cliCredentialFile(dataDir);
    if (!exists(file)) writeSecret(file, CLI_PREFIX + randomBytes(32).toString("base64url") + "\n");
    // Owner and mode checked (a loose file refuses start-up, ADR-099 E1).
    const token = readSecretFile(
      file,
      process.platform === "win32" ? undefined : process.getuid?.(),
    );
    if (!token.startsWith(CLI_PREFIX) || token.length < CLI_PREFIX.length + 40)
      throw new Error(ownerT()("server-access.cliCredential.bad", { file }));
    registerSecret(token); // S-1: never in a log line
    this.hash = digest(token);
  }
  /** Is `token` this Daisy's command-line credential? (constant time) */
  matches(token: string): boolean {
    return timingSafeEqual(digest(token), this.hash);
  }
  /** A new credential; the old one stops working at once. */
  rotate(): void {
    const token = CLI_PREFIX + randomBytes(32).toString("base64url");
    writeSecret(cliCredentialFile(this.dataDir), token + "\n");
    registerSecret(token);
    this.hash = digest(token);
  }
}
