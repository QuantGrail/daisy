import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientError, DaisyConnections, DaisyClient, DaisyError, setClientTranslator } from "../packages/client/src/index.ts";
import { translator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks } from "../packages/contracts/src/i18n-node.ts";

function hangingFetch(t: { after: (f: () => void) => void }) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
}

test("request timeout reads as a timeout, not the raw abort message", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  hangingFetch(t);
  // P6-23b: the host's translator (here the Chinese pack) says the client's messages.
  setClientTranslator(translator(shippedPacks(), "zh-CN").dynamic);
  t.after(() => setClientTranslator(undefined));
  const pending = new DaisyClient("http://daisy.invalid").request(
    "/sessions",
    "POST",
    {},
  );
  t.mock.timers.tick(15000);
  await assert.rejects(pending, (e: Error) => {
    // Network-class failure (no HTTP status), message in plain words.
    assert.ok(!(e instanceof DaisyError));
    assert.match(e.message, /请求超时（15 秒没有响应）/);
    return true;
  });
});

test("P6-23b: without a host translator the client's messages are the English pack's, with a stable code and key", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  hangingFetch(t);
  setClientTranslator(undefined);
  const pending = new DaisyClient("http://daisy.invalid").request("/sessions", "POST", {});
  t.mock.timers.tick(15000);
  await assert.rejects(pending, (e: ClientError) => {
    assert.ok(e instanceof ClientError);
    assert.equal(e.code, "timeout");
    assert.equal(e.key, "client.error.timeout");
    assert.equal(e.localized, true);
    assert.match(e.message, /timed out .*15 seconds/);
    return true;
  });
  const set = new DaisyConnections();
  assert.throws(() => set.get("nope"), (e: ClientError) => e.code === "connection_not_found" && /No connection named nope/.test(e.message));
  // A host's translator in another language takes over.
  setClientTranslator(translator(shippedPacks(), "zh-CN").dynamic);
  t.after(() => setClientTranslator(undefined));
  assert.throws(() => set.get("nope"), /没有叫 nope 的连接/);
});
