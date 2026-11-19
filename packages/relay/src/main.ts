/**
 * P5-01 (ADR-143): the `daisy-relay` command.
 *
 *   daisy-relay [--config <file>]      run (config: file, then DAISY_RELAY_* env)
 *   daisy-relay --check [--config …]   check the config and the certificate files, then exit
 *   daisy-relay --version | --help
 *
 * SIGHUP re-reads the certificate files; SIGTERM / SIGINT stop (Daisys are
 * told "restarting", code 1012, and reconnect to the next instance).
 */
import { pt, processLanguage, setProcessLanguage, takeLangFlag } from "../../contracts/src/i18n-process.ts";
import { readFileSync } from "node:fs";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { RELAY_COMMAND_NAME, RELAY_NAME } from "../../contracts/src/names.ts";
import { ConfigError, loadConfig, type RelayConfig } from "./config.ts";
import { makeLogger } from "./log.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { startRelay } from "./relay.ts";

export const RELAY_VERSION = "0.1.0";

/** `--help` (said when asked: the language is settled by then). */
const help = () => pt("relay.help", { name: RELAY_NAME, version: RELAY_VERSION, protocol: PROTOCOL_VERSION, cmd: RELAY_COMMAND_NAME });

function readTls(cfg: RelayConfig) {
  const cert = readFileSync(cfg.tls.cert);
  const key = readFileSync(cfg.tls.key);
  const x = new X509Certificate(cert);
  createPrivateKey(key);
  const names = certNames(x);
  if (!names.includes(cfg.domain)) throw new ConfigError("relay.cert.otherName", { domain: cfg.domain });
  // Review L1: a certificate naming anything else — a wildcard, a partial
  // wildcard, one Daisy's subdomain, another domain, an IP — is refused: the
  // relay holds a certificate for exactly its own name, so it cannot decrypt.
  const extra = names.filter((n) => n !== cfg.domain);
  if (extra.length)
    throw new ConfigError("relay.cert.extraNames", { domain: cfg.domain, names: extra.slice(0, 3).join(pt("relay.list.separator")) });
  return { cert, key };
}

/**
 * Every name a certificate is good for: each subjectAltName entry (DNS
 * names lowercased; any other kind kept as `KIND:value` so it never equals
 * the domain), or the subject CN when there is no SAN.
 */
export function certNames(x: X509Certificate): string[] {
  const san = x.subjectAltName;
  if (san) {
    return san.split(/,\s*/).map((e) => {
      const i = e.indexOf(":");
      const kind = e.slice(0, i);
      const v = e.slice(i + 1).replace(/^"|"$/g, "");
      return kind === "DNS" ? v.toLowerCase() : `${kind}:${v}`;
    });
  }
  const cn = /(?:^|\n)CN=([^\n]*)/.exec(x.subject)?.[1];
  return cn ? [cn.toLowerCase()] : [];
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  // P6-23b (ADR-159 §10): `--lang` > DAISY_LANG > the system locale > English.
  const flag = takeLangFlag(argv);
  argv = flag.rest;
  setProcessLanguage(processLanguage(flag.lang, { env, platform: process.platform }));
  let file: string | undefined;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      process.stdout.write(help());
      return 0;
    }
    if (a === "--version" || a === "-v") {
      process.stdout.write(`${RELAY_VERSION}\n`);
      return 0;
    }
    if (a === "--check") check = true;
    else if (a === "--config") {
      file = argv[++i];
      if (!file) {
        process.stderr.write(pt("relay.cli.configNeedsFile") + "\n");
        return 2;
      }
    } else {
      process.stderr.write(`${pt("relay.cli.unknownArg", { arg: a })}\n${help()}`);
      return 2;
    }
  }
  let cfg: RelayConfig;
  let tls: { cert: Buffer; key: Buffer };
  try {
    cfg = loadConfig(file, env);
    tls = readTls(cfg);
  } catch (e) {
    process.stderr.write(`${e instanceof ConfigError ? e.message : pt("relay.cli.configProblem", { why: (e as Error).message })}\n`);
    return 2;
  }
  if (check) {
    process.stdout.write(pt("relay.cli.checkOk", { domain: cfg.domain, host: cfg.listen.host, port: cfg.listen.port }) + "\n");
    return 0;
  }
  const log = makeLogger(cfg.logLevel);
  const relay = await startRelay({
    domain: cfg.domain,
    host: cfg.listen.host,
    port: cfg.listen.port,
    cert: tls.cert,
    key: tls.key,
    limits: cfg.limits,
    allowIdentities: cfg.allowIdentities,
    logger: log,
  });
  process.on("SIGHUP", () => {
    try {
      const t = readTls(cfg);
      relay.setTls(t.cert, t.key);
      log.info("tls.reloaded", {});
    } catch {
      log.error("tls.reload_failed", { reason: "bad_files" });
    }
  });
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  await relay.close();
  return 0;
}
