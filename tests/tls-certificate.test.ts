/**
 * P6-15 (ADR-158, P5N-3): the outside face's self-signed certificate is
 * made only for the documented reasons (missing, not covering the host,
 * expiring) and said each time; a loose key of ours is tightened, never
 * replaced; anything else wrong refuses the face. Its SHA-256 (DER, colon
 * hex) is what `daisy access show`, `daisy pair` and the settings page give.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onLog } from "../packages/daisy/src/observe/log.ts";
import { currentFingerprint, tlsFiles, tlsMaterial, TlsRefused } from "../packages/daisy/src/access/tls.ts";
import { selfSignedWarning } from "../packages/daisy/src/access/outside-link.ts";
import { renderPairingCode } from "../packages/daisy/src/cli/table.ts";
import { createApp } from "../packages/daisy/src/app.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { pinDouble } from "./fixtures/pin-double.ts";

const posix = process.platform !== "win32";
const tmp = () => mkdtempSync(join(tmpdir(), "daisy-tls-"));
/** openssl x509 -fingerprint -sha256 of a PEM: SHA-256 over the DER, upper-case colon hex. */
const opensslStyle = (pem: string) =>
  createHash("sha256")
    .update(new X509Certificate(pem).raw)
    .digest("hex")
    .toUpperCase()
    .match(/../g)!
    .join(":");
const logged = (fn: () => void) => {
  const lines: string[] = [];
  const off = onLog((l: any) => lines.push(`${l.level} ${l.text}`));
  try {
    fn();
  } finally {
    off();
  }
  return lines;
};

test("first use makes a certificate (reason: missing), said in the log with its fingerprint; the next start keeps it", () => {
  const dir = tmp();
  try {
    let m!: ReturnType<typeof tlsMaterial>;
    const lines = logged(() => (m = tlsMaterial(dir, "127.0.0.1")));
    assert.equal(m.generated?.reason, "missing");
    assert.equal(m.fingerprint, opensslStyle(m.cert));
    assert.match(m.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.ok(lines.some((l) => l.includes("made a new self-signed certificate") && l.includes(m.fingerprint)), lines.join("\n"));
    assert.ok(!lines.some((l) => l.includes("PRIVATE KEY")));
    assert.equal(currentFingerprint(dir), m.fingerprint);
    const again = tlsMaterial(dir, "127.0.0.1");
    assert.equal(again.generated, undefined);
    assert.equal(again.fingerprint, m.fingerprint);
    assert.ok(again.key.trim() === m.key.trim(), "the same key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a key file readable by others (ours) is tightened to 0600 and the certificate is NOT replaced", { skip: !posix }, () => {
  const dir = tmp();
  try {
    const first = tlsMaterial(dir, "127.0.0.1");
    const f = tlsFiles(dir);
    chmodSync(f.key, 0o644);
    chmodSync(f.cert, 0o644);
    let m!: ReturnType<typeof tlsMaterial>;
    const lines = logged(() => (m = tlsMaterial(dir, "127.0.0.1")));
    assert.equal(m.generated, undefined, "a loose key must not rotate the certificate");
    assert.equal(m.fingerprint, first.fingerprint);
    assert.equal(statSync(f.key).mode & 0o777, 0o600);
    assert.equal(statSync(f.cert).mode & 0o777, 0o600);
    assert.ok(lines.some((l) => l.includes("tightened") && l.includes("certificate was not changed")), lines.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("files that are there but unusable refuse the outside face instead of a quiet new certificate", () => {
  const cases: [string, (f: { cert: string; key: string }) => void, RegExp][] = [
    ["empty key", (f) => writeFileSync(f.key, ""), /为空/],
    ["broken certificate", (f) => writeFileSync(f.cert, "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n"), /读不了/],
    [
      "key of another pair",
      (f) => writeFileSync(f.key, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" })),
      /不是一对/,
    ],
    ...(posix
      ? ([
          [
            "key is a link",
            (f: { cert: string; key: string }) => {
              writeFileSync(`${f.key}.real`, readFileSync(f.key), { mode: 0o600 });
              rmSync(f.key);
              symlinkSync(`${f.key}.real`, f.key);
            },
            /符号链接/,
          ],
        ] as [string, (f: { cert: string; key: string }) => void, RegExp][])
      : []),
  ];
  for (const [what, spoil, words] of cases) {
    const dir = tmp();
    try {
      tlsMaterial(dir, "127.0.0.1");
      const f = tlsFiles(dir);
      spoil(f);
      const before = readFileSync(f.cert, "utf8");
      assert.throws(() => tlsMaterial(dir, "127.0.0.1"), (e: any) => e instanceof TlsRefused && words.test(e.message) && /access show/.test(e.message), what);
      assert.equal(readFileSync(f.cert, "utf8"), before, `${what}: the certificate stays as it was`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("review L4: a dangling link in place of the certificate or key is refused, never written over", { skip: !posix }, () => {
  for (const which of ["cert", "key"] as const) {
    const dir = tmp();
    try {
      tlsMaterial(dir, "127.0.0.1");
      const f = tlsFiles(dir);
      rmSync(f[which]);
      symlinkSync(join(dir, "nowhere.pem"), f[which]);
      assert.throws(() => tlsMaterial(dir, "127.0.0.1"), (e: any) => e instanceof TlsRefused && /符号链接/.test(e.message) && !e.reason.includes(dir), which);
      assert.equal(lstatSync(f[which]).isSymbolicLink(), true, `${which}: still the link`);
      assert.equal(existsSync(join(dir, "nowhere.pem")), false, `${which}: nothing written through it`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("the documented reasons still make a new one: another host (host), half of the pair gone (missing)", () => {
  const dir = tmp();
  try {
    const first = tlsMaterial(dir, "127.0.0.1");
    const other = tlsMaterial(dir, "10.1.2.3");
    assert.equal(other.generated?.reason, "host");
    assert.notEqual(other.fingerprint, first.fingerprint);
    // 0.0.0.0 is covered by whatever is there.
    assert.equal(tlsMaterial(dir, "0.0.0.0").generated, undefined);
    rmSync(tlsFiles(dir).key);
    const again = tlsMaterial(dir, "10.1.2.3");
    assert.equal(again.generated?.reason, "missing");
    assert.match(again.generated!.detail, /tls-key\.pem/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the words a pairing code / outside link carries name the fingerprint and `daisy access show`", () => {
  const fp = "AB:".repeat(31) + "CD";
  assert.match(selfSignedWarning(fp), new RegExp(`${fp}.*access show`));
  assert.match(selfSignedWarning(null), /access show/);
  const out: string[] = [];
  renderPairingCode(
    { code: "ABCD-EFGH", url: "https://h:1/#pair=ABCD-EFGH", via: "direct", certificate: "self-signed", warning: selfSignedWarning(fp), fingerprint: fp, expiresAt: Date.now() + 60_000 },
    { io: { out: (s: string) => out.push(s) } as any },
  );
  assert.match(out.join("\n"), new RegExp(`证书 SHA-256[：:].*${fp}`));
});

test("the app: access show, the pairing code and the audit carry the certificate's fingerprint; unusable files → 409 tls_refused", async () => {
  const dir = tmp();
  const pin = pinDouble();
  const ctx = await createApp({
    pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    pin,
    sharedHost: () => false,
    peerIsOwner: () => true,
  });
  const cli = readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim();
  const asCli = { authorization: `Bearer ${cli}` };
  const g = () => ({ ...asCli, [PIN_GRANT_HEADER]: pin.grant("246810", "cli").grant });
  const local = (o: any) => ctx.app.inject(o);
  try {
    const off = (await local({ url: "/api/access", headers: asCli })).json();
    assert.equal(off.external.fingerprint, null);
    const on = await local({ method: "PUT", url: "/api/access/external", headers: g(), payload: { host: "127.0.0.1" } });
    assert.equal(on.statusCode, 200, on.body);
    const fp = on.json().external.fingerprint;
    assert.equal(fp, opensslStyle(readFileSync(tlsFiles(dir).cert, "utf8")));
    assert.equal((await local({ url: "/api/access", headers: asCli })).json().external.fingerprint, fp);
    const rows = ctx.store.all("SELECT * FROM audit WHERE action='access.tls.generate'");
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].target), { reason: "missing", host: "127.0.0.1", fingerprint: fp });
    const pair = await local({ method: "POST", url: "/api/devices/pair", headers: g(), payload: {} });
    assert.equal(pair.statusCode, 200, pair.body);
    assert.equal(pair.json().fingerprint, fp);
    assert.ok(pair.json().warning.includes(fp));
    const code = await local({ method: "POST", url: "/api/web/open-code/external", headers: g() });
    assert.equal(code.json().fingerprint, fp);
    // Turning it on again with the same certificate: no new audit row.
    assert.equal((await local({ method: "PUT", url: "/api/access/external", headers: g(), payload: { host: "127.0.0.1" } })).statusCode, 200);
    assert.equal(ctx.store.all("SELECT * FROM audit WHERE action='access.tls.generate'").length, 1);
    // A broken certificate file: refused, said how to go on; nothing replaced.
    writeFileSync(tlsFiles(dir).cert, "garbage");
    const refused = await local({ method: "PUT", url: "/api/access/external", headers: g(), payload: { host: "127.0.0.1" } });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().code, "tls_refused");
    assert.ok(!refused.json().error?.includes?.(dir) && !JSON.stringify(refused.json()).includes(dir), "review L5: no paths in the answer");
    assert.equal(readFileSync(tlsFiles(dir).cert, "utf8"), "garbage");
    assert.equal((await local({ url: "/api/access", headers: asCli })).json().external.fingerprint, null);
  } finally {
    await ctx.access.faces.stopExternal();
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
