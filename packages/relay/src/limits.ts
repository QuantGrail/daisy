/**
 * P5-01 (ADR-143 §5): the counters behind the limits — token buckets, and a
 * bounded table of per-address entries (IPv4 address; IPv6 by /64, since one
 * host usually holds a whole /64).
 */
import { isIPv4, isIPv6 } from "node:net";

export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly rate: number, // per second
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }
  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
  }
  /** Take `n` if there are; false (and nothing taken) if not. */
  take(n = 1): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
  /** Whether `n` could be taken now (nothing taken). */
  can(n = 1): boolean {
    this.refill();
    return this.tokens >= n;
  }
  /** Give `n` back (never above the burst). */
  refund(n = 1) {
    this.refill();
    this.tokens = Math.min(this.burst, this.tokens + n);
  }
  /** Take `n` even into debt; how many ms until the debt is paid (0 = none). For byte throttling. */
  reserve(n: number): number {
    this.refill();
    this.tokens -= n;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.rate) * 1000);
  }
  /** Full again (nothing to remember). */
  get idle(): boolean {
    this.refill();
    return this.tokens >= this.burst;
  }
}

/** `::ffff:1.2.3.4` → `1.2.3.4`; anything else as is. */
export function plainIp(addr: string | undefined): string {
  if (!addr) return "unknown";
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return m ? m[1]! : addr;
}

/** Expand an IPv6 address to its 8 groups (numbers); null if it is not one. */
function v6Groups(ip: string): number[] | null {
  const zone = ip.indexOf("%");
  const a = zone >= 0 ? ip.slice(0, zone) : ip;
  if (!isIPv6(a)) return null;
  let tail: number[] = [];
  let head = a;
  // An embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) is two groups.
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (m) {
    const o = m[2]!.split(".").map(Number);
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    head = m[1]!.endsWith("::") ? m[1]! : m[1]!.slice(0, -1);
  }
  let groups: number[];
  const hex = (g: string) => parseInt(g, 16) || 0;
  if (head.includes("::")) {
    const [l, r] = head.split("::");
    const left = l ? l.split(":").map(hex) : [];
    const right = r ? r.split(":").map(hex) : [];
    groups = [...left, ...Array(8 - tail.length - left.length - right.length).fill(0), ...right];
  } else groups = head.split(":").map(hex);
  return [...groups, ...tail];
}

const prefix = (g: number[], bits: number) => {
  const out: string[] = [];
  for (let i = 0; i * 16 < bits; i++) {
    const keep = Math.min(16, bits - i * 16);
    out.push(((g[i]! >> (16 - keep)) << (16 - keep)).toString(16));
  }
  return `${out.join(":")}::/${bits}`;
};

/**
 * The keys one source counts under, most specific first: an IPv4 address
 * alone; an IPv6 address as its /64, /56 and /48 (review M1 / L2: a host
 * holding a whole prefix gets one share per tier, not one per address).
 */
export function sourceKeys(ip: string): { key: string; tier: 0 | 1 | 2 }[] {
  if (isIPv4(ip)) return [{ key: ip, tier: 0 }];
  const g = v6Groups(ip);
  if (!g) return [{ key: ip, tier: 0 }];
  return [
    { key: prefix(g, 64), tier: 0 },
    { key: prefix(g, 56), tier: 1 },
    { key: prefix(g, 48), tier: 2 },
  ];
}

/** The /64 key (IPv4 as is) — kept for logs and tests. */
export const ipKey = (ip: string) => sourceKeys(ip)[0]!.key;

export interface IpEntry {
  conns: number;
  unauth: number;
  daisys: number;
  newConn: TokenBucket;
  own: TokenBucket;
}

type Counter = "conns" | "unauth" | "daisys";
type Bucket = "newConn" | "own";

/**
 * Per-source accounting over all tiers, at most `max` entries. Only entries
 * with nothing counted and full buckets are forgotten, so forgetting resets
 * nothing (L2). When the table is full of live entries a new source is
 * refused (fail closed) rather than given fresh buckets.
 */
export class Sources {
  private readonly m = new Map<string, IpEntry>();
  constructor(
    private readonly max: number,
    private readonly factors: [number, number, number],
    private readonly rates: { newConn: [number, number]; own: [number, number] },
  ) {}
  private entry(key: string, tier: 0 | 1 | 2): IpEntry | null {
    let e = this.m.get(key);
    if (e) return e;
    if (this.m.size >= this.max) this.sweep();
    if (this.m.size >= this.max) return null;
    const f = this.factors[tier];
    e = {
      conns: 0,
      unauth: 0,
      daisys: 0,
      newConn: new TokenBucket(this.rates.newConn[0] * f, this.rates.newConn[1] * f),
      own: new TokenBucket(this.rates.own[0] * f, this.rates.own[1] * f),
    };
    this.m.set(key, e);
    return e;
  }
  private all(ip: string): { e: IpEntry; f: number }[] | null {
    const out: { e: IpEntry; f: number }[] = [];
    for (const k of sourceKeys(ip)) {
      const e = this.entry(k.key, k.tier);
      if (!e) return null;
      out.push({ e, f: this.factors[k.tier] });
    }
    return out;
  }
  /** Count one `what` for `ip` if every tier is under `limit` (× its factor); the release, or null. */
  admit(ip: string, what: Counter, limit: number): (() => void) | null {
    const es = this.all(ip);
    if (!es || es.some(({ e, f }) => e[what] >= limit * f)) return null;
    for (const { e } of es) e[what]++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const { e } of es) e[what]--;
    };
  }
  /** Take a token from `which` on every tier, or none. */
  take(ip: string, which: Bucket): boolean {
    const es = this.all(ip);
    if (!es || es.some(({ e }) => !e[which].can())) return false;
    for (const { e } of es) e[which].take();
    return true;
  }
  refund(ip: string, which: Bucket) {
    const es = this.all(ip);
    if (es) for (const { e } of es) e[which].refund();
  }
  sweep() {
    for (const [k, v] of this.m)
      if (v.conns === 0 && v.unauth === 0 && v.daisys === 0 && v.newConn.idle && v.own.idle) this.m.delete(k);
  }
  get size() {
    return this.m.size;
  }
}
