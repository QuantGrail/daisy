// The owner (P1-03, D-01): one Daisy, one owner — the system account
// that runs it. No accounts, no roles.
export interface User {
  /** Always the same id (the owner's rows carry it as owner_id). */
  id: string;
  /** The system account's login name. */
  username: string;
}
/** GET /api/me: the owner, and how this request was recognised. */
export interface Me extends User {
  /** `issuer`: a token the configured external issuer signed for the owner (P2-01). */
  channel: "web" | "device" | "cli" | "issuer";
  face: "local" | "external";
  /** P5-03: a paired device — which one (its id). */
  deviceId?: string;
}
