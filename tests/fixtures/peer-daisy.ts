/**
 * P4-03 tests: another Daisy — its own data directory, Ed25519 identity
 * key and card — signing its own cross-Daisy tokens (token.md §3 `a2a`)
 * as P4-08 will. (The same as tests/contacts.test.ts's `other`.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelfIssuer } from "../../packages/daisy/src/access/tokens/self-issuer.ts";
import { makeCard, cardText } from "../../packages/daisy/src/contacts/card.ts";

export async function peerDaisy(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `daisy-peer-${name}-`));
  const self = await SelfIssuer.open(dir);
  const card = await makeCard(self, { name, addrs: [{ kind: "direct", url: `https://${name.toLowerCase()}.example.net:29600` }] });
  /** A cross-Daisy access token for `aud` (client_id a2a, sub = iss), acting through one of its AIs. */
  const token = (aud: string, o: { actor?: string } = {}) =>
    self
      .sign({
        sub: self.urn,
        aud,
        clientId: "a2a",
        scope: "daisy:invoke",
        ttlS: 300,
        act: { sub: o.actor ?? "agent:s-1", name: "研究助手" },
      })
      .then((t) => t.token);
  return { dir, self, card, text: cardText(card), token, close: () => rmSync(dir, { recursive: true, force: true }) };
}
export type PeerDaisy = Awaited<ReturnType<typeof peerDaisy>>;
