/**
 * P1-03 (ADR-110): single owner and local authentication — the pieces put
 * together for createApp. See guard.ts for the checks, faces.ts for the
 * two faces, routes.ts for the routes that hand out web sessions and
 * change the faces.
 */
import type { FastifyInstance } from "fastify";
import type { Store } from "../store/index.ts";
import { CliCredential, cliCredentialFile } from "./cli-credential.ts";
import { WebSessions } from "./web-sessions.ts";
import { AiCredentials } from "./ai-credential.ts";
import { Faces } from "./faces.ts";
import { accessGuard } from "./guard.ts";
import { readAccessConfig, writeAccessConfig } from "./config.ts";
import { sharedHost as detectShared } from "./shared-host.ts";
import type { PinService } from "./pin-seam.ts";
import { peerIsOwner as detectPeer } from "./peer.ts";
import { ExternalIssuer, httpIssuerPolicy } from "./tokens/external-issuer.ts";
import { DelegatedTokens } from "./tokens/delegate.ts";
import { registerSecret } from "../observe/redact.ts";
import { UiOrigins } from "./ui-origins.ts";
import { Contacts } from "../contacts/index.ts";
import { InvokeAccess } from "../invoke/invoke-access.ts";
import { identityId } from "../contacts/identity.ts";
import { Revocations } from "./revocations.ts";
import { VisitorTokens } from "./visitor-tokens.ts";
import { OWNER_ID } from "./owner.ts";
import { Devices } from "./devices.ts";
import { readRelayConfig } from "../relay/config.ts";

export { OWNER_ID, ownerUser } from "./owner.ts";
export { cliCredentialFile } from "./cli-credential.ts";
export type { Principal } from "./guard.ts";
export type { PinService } from "./pin-seam.ts";
export { PIN_GRANT_HEADER } from "./pin-seam.ts";
export { Revocations, type RevokeHook, type RevocationSummary } from "./revocations.ts";

export interface AccessOptions {
  dataDir: string;
  /** P1-05's PIN (absent: every `pin: true` route is refused). */
  pin?: PinService;
  /** Tests: is this a shared machine (default: detect, shared-host.ts). */
  sharedHost?: () => boolean;
  /** Tests: is the process at the other end the owner's (default: peer.ts). */
  peerIsOwner?: (req: any) => boolean;
}

export async function setupAccess(
  app: FastifyInstance,
  store: Store,
  o: AccessOptions,
) {
  const cli = new CliCredential(o.dataDir);
  const web = new WebSessions(o.dataDir);
  const ai = await AiCredentials.open(o.dataDir);
  const shared = o.sharedHost ?? (() => detectShared());
  // Review M-3: plain http to a loopback issuer — DAISY_ALLOW_HTTP_ISSUER=1
  // on a machine nobody else has an account on, checked before every fetch.
  const httpIssuer = httpIssuerPolicy(shared);
  // P2-01: the external issuer the owner configured (none: self-issued only).
  let external: ExternalIssuer | null = ExternalIssuer.load(o.dataDir, httpIssuer);
  // P4-03: set up below, once the address book exists.
  let invoke: InvokeAccess | undefined;
  const issuer = {
    get: () => external,
    /** After the owner configured or removed it (issuer-routes.ts). */
    set(x: ExternalIssuer | null) {
      external = x;
      delegated.clear();
      // P4-03 review M-2: the people the previous issuer vouched for are
      // nobody now — their grants, cards and calls go (sync, inside the
      // route's commit).
      invoke?.forgetIssuersBut(x?.issuer ?? null);
    },
  };
  // P2-02: tokens fetched for the AI of a running turn.
  const delegated = new DelegatedTokens({
    self: ai.self,
    external: () => external,
    // P1-11 (S-1): every token handed to an AI is masked wherever it shows up.
    registerSecret,
    audit: (action, detail) => {
      try {
        // Who: the AI whose token it is (the guard's label for it).
        store.audit(`ai:${String(detail.session)}`, action, JSON.stringify(detail));
      } catch {
        // The audit never fails the request.
      }
    },
  });
  // P4-02 (5.11 「PIN 码」, T-9): what a PIN reset takes back — one hook
  // per kind; the stores of phase 4 / 5 register theirs here
  // (`access.revocations.register`).
  const revocations = new Revocations();
  // P2-02: the tokens fetched for an AI are forgotten (never handed out
  // again; they run out within the hour where they were sent). Before the
  // issuer's hook, which forgets them too (without counting).
  revocations.register(
    "ai-tokens",
    "access/index.ts: tokens fetched for an AI (P2-02)",
    () => delegated.revokeAll(),
    { outside: true },
  );
  // Review H-1 (5.11, T-9): resetting the PIN takes back every trust that
  // lets others in — the external issuer and the owner token kept for it
  // too. Files: after every database hook; doing it twice is harmless.
  // Review L-1: the files go first, then memory — a removal that fails
  // leaves this process trusting no more than the disk does.
  revocations.register(
    "issuer",
    "access/index.ts: external issuer (P2-01)",
    () => {
      const had = external ? 1 : 0;
      ExternalIssuer.remove(o.dataDir);
      issuer.set(null);
      return had;
    },
    { outside: true },
  );
  // P4-01 (5.6): the address book — whose tokens are recognised. Resetting
  // the PIN removes every contact and their whitelist flags (5.11 PIN 码,
  // T-9): a database hook, inside the reset's transaction.
  const contacts = new Contacts(store, identityId(ai.self.publicJwk));
  // P4-03 (5.6, ADR-122): call authorization on top of the address book.
  // Its reset hook comes before the contacts' (the removal would take the
  // contacts' grants with it and leave nothing to count): permanent grants,
  // named lists, whitelist flags, pending cards — in the transaction; then,
  // outside it, every call in progress stops.
  const inv = new InvokeAccess(store, contacts, { issuer: () => external?.issuer ?? null });
  invoke = inv;
  revocations.register(
    "invoke-grants",
    "invoke/invoke-access.ts: grants, named lists, whitelist flags, pending call cards (P4-03)",
    () => inv.revokeAll(),
  );
  revocations.register(
    "invoke-grants",
    "invoke/invoke-access.ts: calls in progress stop (P4-03)",
    () => {
      inv.stopAll();
      return 0;
    },
    { outside: true },
  );
  // P4-12 (token.md §7, ADR-132): `daisy token` — tokens this Daisy signs
  // for third-party A2A clients. A removed contact's go with them; a PIN
  // reset revokes every one (before the contacts' hook, which would
  // otherwise revoke the contacts' tokens first and leave nothing to count).
  const visitorTokens = new VisitorTokens(store, ai.self, contacts);
  revocations.register(
    "visitor-tokens",
    "access/visitor-tokens.ts: tokens signed for third-party A2A clients (P4-12)",
    () => visitorTokens.revokeAll(),
  );
  revocations.register("contacts", "contacts/index.ts: mutually recognised cards and their whitelist (P4-01)", () =>
    contacts.removeAll(),
  );
  // P5-03 (ADR-142): paired devices. A PIN reset revokes every one (T-9):
  // the records in the reset's transaction; then, outside it, the unused
  // pairing codes, every device session and every device's live socket.
  const devices = new Devices(store, web, { pin: () => o.pin });
  revocations.register("devices", "access/devices.ts: paired devices (P5-03)", () => devices.revokeAllRecords());
  revocations.register(
    "devices",
    "access/devices.ts: pairing codes, device sessions and sockets (P5-03)",
    () => {
      devices.dropEverything();
      return 0;
    },
    { outside: true },
  );
  const faces = new Faces(app, o.dataDir);
  // P6-15 (ADR-158): every new outside-face certificate in the audit — why,
  // for which address, its fingerprint (never the key).
  faces.onCertificate = (m) =>
    store.audit("system", "access.tls.generate", JSON.stringify({ reason: m.reason, host: m.host, fingerprint: m.fingerprint }));
  // Review H-1 (P4-02): the outside face goes off, and with it every web
  // session and unused one-time code made for it — while no PIN is set,
  // nobody from elsewhere may be the owner (and set a PIN of their own).
  // Off at once (the listener drops its connections now; closing it
  // finishes on its own), saved disabled.
  revocations.register(
    "external-face",
    "access/index.ts: the outside face, its web sessions and codes (P1-03)",
    () => {
      const had = faces.externalListening || config().external.enabled ? 1 : 0;
      writeAccessConfig(o.dataDir, (c) => ({ ...c, external: { ...c.external, enabled: false } }));
      void faces.stopExternal().catch(() => {});
      web.drop("external");
      return had;
    },
    { outside: true },
  );
  // P2-04: browser origins of external interfaces the owner allowed.
  const uiOrigins = new UiOrigins(o.dataDir);
  // Resetting the PIN takes back every trust that lets others in (H-1,
  // T-9): the allowed interface origins too.
  revocations.register(
    "ui-origins",
    "access/index.ts: allowed external interface origins (P2-04)",
    () => {
      const had = uiOrigins.get().length;
      uiOrigins.set([]);
      return had;
    },
    { outside: true },
  );
  // P4-02 (T-9): the reset runs every hook in its transaction and leaves a
  // record of what it took back — and what is not built yet (`pending`).
  // The row is in the same transaction: no record, no reset.
  o.pin?.onReset(() => {
    const summary = revocations.runAll();
    store.audit(OWNER_ID, "pin.reset.revoke", JSON.stringify(summary), {
      object: "pin",
    });
  });
  const config = () => readAccessConfig(o.dataDir);
  /** D-09: the passcode applies on the local face. */
  const passcodeOn = () => {
    const c = config();
    // P5-02: a relay reaches the outside face from anywhere — the same as listening.
    if (c.passcode === "on" || c.external.enabled || readRelayConfig(o.dataDir).enabled) return true;
    if (c.passcode === "off") return false;
    return shared();
  };
  const guard = accessGuard({
    store,
    cli,
    web,
    ai,
    faces,
    pin: () => o.pin,
    passcodeOn,
    config,
    external: () => external,
    uiOrigins: () => uiOrigins.get(),
    contacts,
    visitorTokens,
    devices,
  });
  return {
    dataDir: o.dataDir,
    cli,
    cliFile: cliCredentialFile(o.dataDir),
    web,
    ai,
    faces,
    guard,
    config,
    passcodeOn,
    sharedHost: shared,
    peerIsOwner: o.peerIsOwner ?? ((req: any) => detectPeer(req)),
    pin: () => o.pin,
    issuer,
    httpIssuer,
    delegated,
    uiOrigins,
    contacts,
    /** P4-03: call authorization (grants, ranges, cards, calls in progress). */
    invoke: inv,
    /** P4-12: `daisy token` (tokens for third-party A2A clients). */
    visitorTokens,
    /** P5-03: paired devices (pairing codes, records, device sessions). */
    devices,
    /** P4-02: what a PIN reset takes back — register a store's hook here. */
    revocations,
    /** P5-02: the relay address for identity cards (set by createApp; null when off). */
    relayAddress: (() => null) as () => string | null,
  };
}
export type Access = Awaited<ReturnType<typeof setupAccess>>;
