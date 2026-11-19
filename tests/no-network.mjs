// P5-02 security review L-4: the tests' no-network guard. Preloaded by
// scripts/ci-test.mjs (NODE_OPTIONS, so every child process too) and by
// `npm test`: any DNS lookup of a name other than localhost, and any TCP
// connection to an address other than loopback, is refused — no test may
// reach the internet (a test once reached Let's Encrypt, ADR-144).
// Allowed: loopback, this machine's own interface addresses (the traffic
// stays on the host), and lookups of IP literals (no DNS server is asked).
// NO_NET_LOG=<file>: every refusal is appended there (with a short stack).
import net from "node:net";
import dns from "node:dns";
import { appendFileSync } from "node:fs";
const LOG = process.env.NO_NET_LOG;
import { networkInterfaces } from "node:os";
/** This machine's own interface addresses: a connection to one never leaves the host. */
const own = new Set(
  Object.values(networkInterfaces())
    .flat()
    .map((i) => String(i?.address ?? "").replace(/%.*$/, "").toLowerCase())
    .filter(Boolean),
);
const loop = (h) => {
  if (h === undefined || h === null || h === "") return true; // net default: localhost
  const s = String(h).replace(/^\[|\]$/g, "").toLowerCase();
  if (s === "localhost" || s.endsWith(".localhost")) return true;
  if (own.has(s)) return true;
  if (net.isIPv4(s)) return s.startsWith("127.");
  if (net.isIPv6(s)) return s === "::1" || /^::ffff:127\./.test(s);
  return false;
};
/** A lookup of an IP literal asks no DNS server (listening on `::` / `0.0.0.0` does this). */
const literal = (h) => net.isIP(String(h ?? "").replace(/^\[|\]$/g, "")) !== 0;
const refuse = (what) => {
  const m = `no-network guard: refused ${what}`;
  if (LOG) appendFileSync(LOG, `${process.pid} ${m}\n${new Error().stack.split("\n").slice(2, 9).join("\n")}\n`);
  return new Error(m);
};
const origLookup = dns.lookup;
dns.lookup = function (host, opts, cb) {
  if (typeof opts === "function") (cb = opts), (opts = {});
  if (!literal(host) && !loop(host)) return process.nextTick(() => cb(Object.assign(refuse(`DNS lookup ${host}`), { code: "ENOTFOUND" })));
  return origLookup.call(this, host, opts, cb);
};
const origPLookup = dns.promises.lookup;
dns.promises.lookup = async function (host, opts) {
  if (!literal(host) && !loop(host)) throw Object.assign(refuse(`DNS lookup ${host}`), { code: "ENOTFOUND" });
  return origPLookup.call(this, host, opts);
};
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  try { check(args); } catch (e) { process.nextTick(() => this.destroy(e)); return this; }
  return origConnect.apply(this, args);
};
function check(args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  if (o && typeof o === "object") {
    if (!o.path && net.isIP(String(o.host ?? "").replace(/^\[|\]$/g, "")) && !loop(o.host)) throw refuse(`connect ${o.host}:${o.port}`);
  } else if (typeof o === "number" || (typeof o === "string" && /^\d+$/.test(o))) {
    const h = args[1];
    if (typeof h === "string" && net.isIP(h) && !loop(h)) throw refuse(`connect ${h}:${o}`);
  }
}
import { syncBuiltinESMExports } from "node:module";
syncBuiltinESMExports();
