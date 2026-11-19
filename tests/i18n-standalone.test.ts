/**
 * P6-23b (ADR-159 §10): the shared A2A client (packages/a2a-client) and
 * the standalone commands speak through the language packs — one process
 * language (`--lang` > DAISY_LANG > the system > English), errors that
 * carry their message key (a host says them again in its reader's
 * language), identity cards written in one language and read in any.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { CompactSign } from "jose";
import { cardText, CardError, makeCard, readCard, OutboundError, outboundUrl, signA2AToken } from "../packages/a2a-client/src/index.ts";
import { envLanguage, KeyedError, processLanguage, pt, setProcessLanguage, setProcessTranslator, takeLangFlag } from "../packages/contracts/src/i18n-process.ts";
import { translator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks } from "../packages/contracts/src/i18n-node.ts";
import { ConfigError, checkDomain } from "../packages/relay/src/config.ts";
import { isLocalized } from "../packages/daisy/src/app/errors.ts";

const CJK = /[　-〿一-鿿＀-￯]/;

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  return {
    publicJwk,
    signCard: (payload: Record<string, unknown>) =>
      new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
        .setProtectedHeader({ alg: "EdDSA", typ: "daisy-card+jwt" })
        .sign(privateKey),
  };
}

test("the process language: --lang > DAISY_LANG > the system > English; the flag is taken out of argv", () => {
  assert.deepEqual(takeLangFlag(["--lang", "en", "card", "--name", "x"]), { lang: "en", rest: ["card", "--name", "x"] });
  assert.deepEqual(takeLangFlag(["--lang=zh-CN", "--help"]), { lang: "zh-CN", rest: ["--help"] });
  assert.deepEqual(takeLangFlag(["--help"]), { rest: ["--help"] });
  const none = { apple: () => [], intl: () => undefined };
  assert.equal(processLanguage("en", { env: { DAISY_LANG: "zh-CN" }, platform: "linux", ...none }), "en");
  assert.equal(processLanguage(undefined, { env: { DAISY_LANG: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, platform: "linux", ...none }), "zh-CN");
  assert.equal(processLanguage(undefined, { env: { LANG: "C", LANGUAGE: "zh_TW:en" }, platform: "linux", ...none }), "zh-CN");
  assert.equal(processLanguage(undefined, { env: {}, platform: "darwin", apple: () => ["zh-Hans-CN"], intl: () => "en-US" }), "zh-CN");
  assert.equal(processLanguage(undefined, { env: {}, platform: "linux", ...none }), "en");
  assert.equal(processLanguage("xx", { env: { LANG: "fr_FR.UTF-8" }, platform: "linux", ...none }), "en");
  assert.equal(envLanguage({ env: { LC_ALL: "en_GB.UTF-8" }, platform: "linux", ...none }, ["en", "zh-CN"]), "en");
});

test("a2a-client: errors carry a stable code and their message key; the text is the process language's; a host may hand its translator", async () => {
  try {
    setProcessLanguage("en");
    const e = await readCard("hello").catch((x) => x);
    assert.ok(e instanceof CardError);
    assert.equal(e.code, "card_invalid");
    assert.equal(e.key, "a2a.card.invalid.noPrefix");
    assert.ok(isLocalized(e), "Daisy's error handler says it again in the request's language");
    assert.match(e.message, /^Invalid card: no line starting with daisy-card:/);
    const o = (() => {
      try {
        outboundUrl("ftp://x.test/", "direct");
      } catch (x) {
        return x as OutboundError;
      }
    })()!;
    assert.equal(o.code, "bad_url");
    assert.equal(o.message, "Only http / https addresses are supported");
    // Daisy's own translator, re-read each time (the owner's language).
    setProcessTranslator(() => translator(shippedPacks(), "zh-CN"));
    assert.match((await readCard("hello").catch((x) => x)).message, /^名片无效：找不到 daisy-card: 开头的那一行/);
    const { privateKey } = generateKeyPairSync("ed25519");
    await assert.rejects(
      signA2AToken(privateKey, { thumbprint: "x".repeat(43), aud: "urn:x", ttlS: 10 }),
      (x: KeyedError) => x.key === "a2a.token.aud" && /身份 URN/.test(x.message),
    );
  } finally {
    setProcessTranslator(undefined);
  }
});

test("identity cards: written in the process language, read in any (English and Chinese labels, traditional ones too)", async () => {
  try {
    const s = signer();
    setProcessLanguage("en");
    const card = await makeCard(s, { name: "Erin", addrs: [{ kind: "direct", url: "https://erin.test" }], note: "hi" });
    const en = cardText(card);
    assert.match(en, /^Daisy identity card\nName: Erin\nNumber: [a-z2-7 ]+\nAddress: https:\/\/erin\.test\nNote: hi\ndaisy-card:1:/);
    assert.doesNotMatch(en.split("daisy-card:")[0]!, CJK);
    const zh = cardText(card, translator(shippedPacks(), "zh-CN"));
    assert.match(zh, /^Daisy 身份名片\n名字：Erin\n编号：/);
    // Either form reads in either language.
    for (const lang of ["en", "zh-CN"]) {
      setProcessLanguage(lang);
      assert.equal((await readCard(en)).id, card.id);
      assert.equal((await readCard(zh)).id, card.id);
    }
    // A people's line in any language that disagrees is refused (and said in the reader's language).
    setProcessLanguage("en");
    const lie = (await readCard(zh.replace("名字：Erin", "名稱：Mallory")).catch((x) => x)) as CardError;
    assert.equal(lie.key, "a2a.card.invalid.lineDiffers");
    assert.match(lie.message, /^Invalid card: the “Name” line says “Mallory”, the signed content says “Erin”/);
    setProcessLanguage("zh-CN");
    const lie2 = (await readCard(en.replace("Note: hi", "note: bye")).catch((x) => x)) as CardError;
    assert.match(lie2.message, /^名片无效：“备注”一行写的是「bye」/);
    const twice = (await readCard(en.replace("Name: Erin", "Name: Erin\nName: Erin")).catch((x) => x)) as CardError;
    assert.equal(twice.key, "a2a.card.invalid.lineTwice");
  } finally {
    setProcessTranslator(undefined);
  }
});

test("relay: config errors are message keys, said in the process language", () => {
  try {
    setProcessLanguage("en");
    assert.throws(() => checkDomain("Relay.Test"), (e: ConfigError) => e.key === "relay.config.domainCase" && e.message === "domain must be lower case");
    setProcessLanguage("zh-CN");
    assert.throws(() => checkDomain("Relay.Test"), /domain 要小写/);
    assert.equal(pt("relay.list.separator"), "、");
  } finally {
    setProcessTranslator(undefined);
  }
});
