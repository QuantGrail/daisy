/**
 * P4-09 (ADR-128 §3, 5.2 「私人 agent 也要有身份」): the MCP's own identity —
 * an Ed25519 key pair made on first use (`identity-key.json`, 0600, the
 * private JWK), never Daisy's. Its identity number and card follow
 * identity-card.md exactly (shared code, packages/a2a-client): a Daisy owner
 * imports the card like any other Daisy's. The card has no address: nobody
 * can call this MCP (it only calls out).
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { CompactSign } from "jose";
import {
  IDENTITY_CARD_TYP,
  formsOfKey,
  makeCard,
  signA2AToken,
  type CardSigner,
  type IdentityCard,
  type IdentityForms,
} from "../../a2a-client/src/index.ts";
import { A2A_CLIENT_LIMITS } from "../../contracts/src/limits.ts";
import { HomeError, type Home } from "./home.ts";

const KEY_FILE = "identity-key.json";

export class McpIdentity implements CardSigner {
  readonly forms: IdentityForms;
  private constructor(
    private privateKey: KeyObject,
    readonly publicJwk: { kty: "OKP"; crv: "Ed25519"; x: string },
  ) {
    this.forms = formsOfKey(publicJwk);
  }

  /** Load the key, making it on first use. */
  static open(home: Home): McpIdentity {
    let text = home.read(KEY_FILE);
    if (text === null) {
      const { privateKey } = generateKeyPairSync("ed25519");
      // Another process may have made it meanwhile: theirs wins.
      home.create(KEY_FILE, JSON.stringify(privateKey.export({ format: "jwk" })) + "\n");
      text = home.read(KEY_FILE)!;
    }
    let jwk: any;
    try {
      jwk = JSON.parse(text);
    } catch {
      jwk = null;
    }
    if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string")
      throw new HomeError("mcp.home.notKey", { path: home.path(KEY_FILE) });
    const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
    const pub = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
    return new McpIdentity(privateKey, { kty: "OKP", crv: "Ed25519", x: pub.x });
  }

  get id() {
    return this.forms.id;
  }
  get urn() {
    return this.forms.urn;
  }

  /** identity-card.md §2: the JWS over the card's fields, signed by this key. */
  async signCard(payload: Record<string, unknown>): Promise<string> {
    return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "EdDSA", typ: IDENTITY_CARD_TYP })
      .sign(this.privateKey);
  }

  /** This MCP's card: no address (5.2: nobody can call it). */
  card(name: string, note: string | null): Promise<IdentityCard> {
    return makeCard(this, { name, addrs: [], note });
  }

  /** A fresh token for one request to the contact `aud` (token.md §3 / §5, shared rules). */
  token(aud: string, act: { sub: string; name?: string }): Promise<string> {
    return signA2AToken(this.privateKey, {
      thumbprint: this.forms.thumbprint,
      aud,
      act,
      ttlS: A2A_CLIENT_LIMITS.tokenTtlS,
    });
  }
}
