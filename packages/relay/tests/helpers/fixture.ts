/**
 * A relay for one test: the fake domain `relay.test`, a fresh test CA, the
 * relay's own certificate for exactly `relay.test`, logs captured as lines.
 */
import { startRelay, type Relay } from "../../src/relay.ts";
import { makeLogger } from "../../src/log.ts";
import type { Limits } from "../../src/config.ts";
import { TestCA, type Leaf } from "./pki.ts";
import { TestDaisy, type TestDaisyOptions } from "./daisy-side.ts";

export const DOMAIN = "relay.test";

export interface Fixture {
  ca: TestCA;
  own: Leaf;
  relay: Relay;
  logs: string[];
  logger: ReturnType<typeof makeLogger>;
  /** Start (or restart, same port) the relay. */
  start(port?: number): Promise<Relay>;
  daisy(o?: Partial<TestDaisyOptions>): TestDaisy;
  close(): Promise<void>;
}

export async function fixture(
  limits: Partial<Limits> = {},
  level: "debug" | "info" = "debug",
  extra: { host?: string; allowIdentities?: string[] } = {},
): Promise<Fixture> {
  const ca = new TestCA();
  const own = ca.issue([DOMAIN]);
  const logs: string[] = [];
  const logger = makeLogger(level, (l) => logs.push(l));
  const daisys: TestDaisy[] = [];
  const f: Fixture = {
    ca,
    own,
    relay: null as unknown as Relay,
    logs,
    logger,
    async start(port = 0) {
      f.relay = await startRelay({
        domain: DOMAIN,
        host: extra.host ?? "127.0.0.1",
        port,
        allowIdentities: extra.allowIdentities,
        cert: own.cert,
        key: own.key,
        limits,
        logger,
      });
      return f.relay;
    },
    daisy(o = {}) {
      const d = new TestDaisy({
        domain: DOMAIN,
        port: f.relay.port,
        ca: ca.cert,
        leaf: (sub) => ca.issue([`${sub}.${DOMAIN}`]),
        ...o,
      });
      daisys.push(d);
      return d;
    },
    async close() {
      for (const d of daisys) await d.stop();
      await f.relay?.close();
    },
  };
  await f.start();
  return f;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` is true, or fail after `ms`. */
export async function until(fn: () => boolean, ms = 5000, what = "condition"): Promise<number> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
  return Date.now() - t0;
}
