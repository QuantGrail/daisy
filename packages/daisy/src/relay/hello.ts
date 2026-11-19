/**
 * P5-02 (ADR-144 §4): what a stream the relay hands over asks for, read
 * from its TLS ClientHello before TLS starts — the server name (SNI,
 * RFC 6066) and the ALPN protocols (RFC 7301). Only to tell a certificate
 * authority's TLS-ALPN-01 check (`acme-tls/1`, RFC 8737) from a call: the
 * check gets the challenge certificate on its own tiny TLS server; a call
 * goes to the outside face's TLS server. Pure and bounded.
 */

export type HelloInfo =
  | { state: "need" }
  | { state: "ok"; sni: string | null; alpn: string[] }
  | { state: "bad"; reason: string };

const MAX_RECORD = 16384;
const bad = (reason: string): HelloInfo => ({ state: "bad", reason });

/** Read the ClientHello from the bytes seen so far (it may span records). */
export function readClientHello(buf: Uint8Array, maxBytes: number): HelloInfo {
  const frags: Uint8Array[] = [];
  let have = 0;
  let off = 0;
  let need: number | null = null;
  while (need === null || have < 4 + need) {
    if (buf.length - off < 5) return buf.length > maxBytes ? bad("too_big") : { state: "need" };
    const type = buf[off]!;
    const len = (buf[off + 3]! << 8) | buf[off + 4]!;
    if (type !== 22) return bad("not_handshake");
    if (buf[off + 1] !== 3) return bad("not_tls");
    if (len === 0 || len > MAX_RECORD) return bad("record_length");
    if (off + 5 + len > maxBytes) return bad("too_big");
    if (buf.length - off - 5 < len) return { state: "need" };
    frags.push(buf.subarray(off + 5, off + 5 + len));
    have += len;
    off += 5 + len;
    if (need === null && have >= 4) {
      const head = Buffer.concat(frags).subarray(0, 4);
      if (head[0] !== 1) return bad("not_client_hello");
      need = (head[1]! << 16) | (head[2]! << 8) | head[3]!;
      if (need + 4 > maxBytes) return bad("too_big");
    }
  }
  const hs = Buffer.concat(frags).subarray(4, 4 + need);
  return body(hs);
}

function body(b: Uint8Array): HelloInfo {
  let o = 0;
  const has = (n: number) => o + n <= b.length;
  const u16 = () => {
    const v = (b[o]! << 8) | b[o + 1]!;
    o += 2;
    return v;
  };
  if (!has(35)) return bad("short");
  o += 34; // version, random
  const sid = b[o++]!;
  if (sid > 32 || !has(sid)) return bad("session_id");
  o += sid;
  if (!has(2)) return bad("short");
  const cs = u16();
  if (cs < 2 || cs % 2 || !has(cs)) return bad("cipher_suites");
  o += cs;
  if (!has(1)) return bad("short");
  const comp = b[o++]!;
  if (comp < 1 || !has(comp)) return bad("compression");
  o += comp;
  if (o === b.length) return { state: "ok", sni: null, alpn: [] };
  if (!has(2)) return bad("short");
  const extLen = u16();
  if (o + extLen !== b.length) return bad("extensions_length");
  const seen = new Set<number>();
  let sni: string | null = null;
  let alpn: string[] = [];
  while (o < b.length) {
    if (!has(4)) return bad("extension");
    const type = u16();
    const len = u16();
    if (!has(len)) return bad("extension");
    if (seen.has(type)) return bad("duplicate_extension");
    seen.add(type);
    const e = b.subarray(o, o + len);
    if (type === 0) {
      const r = serverName(e);
      if (r === null) return bad("server_name");
      sni = r;
    } else if (type === 16) {
      const r = protocols(e);
      if (r === null) return bad("alpn");
      alpn = r;
    }
    o += len;
  }
  return { state: "ok", sni, alpn };
}

function serverName(e: Uint8Array): string | null {
  if (e.length < 5 || ((e[0]! << 8) | e[1]!) + 2 !== e.length) return null;
  let o = 2;
  let host: string | null = null;
  while (o < e.length) {
    if (o + 3 > e.length) return null;
    const t = e[o]!;
    const len = (e[o + 1]! << 8) | e[o + 2]!;
    o += 3;
    if (!len || o + len > e.length) return null;
    if (t === 0) {
      if (host !== null) return null;
      const raw = e.subarray(o, o + len);
      if (raw.some((c) => c < 0x21 || c > 0x7e)) return null;
      host = Buffer.from(raw).toString("ascii").toLowerCase();
    }
    o += len;
  }
  return host;
}

function protocols(e: Uint8Array): string[] | null {
  if (e.length < 2 || ((e[0]! << 8) | e[1]!) + 2 !== e.length) return null;
  const out: string[] = [];
  let o = 2;
  while (o < e.length) {
    const len = e[o++]!;
    if (!len || o + len > e.length) return null;
    out.push(Buffer.from(e.subarray(o, o + len)).toString("latin1"));
    o += len;
  }
  return out.length ? out : null;
}
