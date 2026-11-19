// This machine's Runner as the UI sees it (P1-00: moved from index.ts).
// P1-02: the Runner runs inside the Daisy process; P1-03: no machine
// management — one Daisy, one machine, so the catalog lists exactly one.
export interface NodeInfo {
  id: string;
  /** In the request's language when it is Daisy's own default name (P6-28). */
  label: string;
  /** The label is Daisy's default ("This machine"): `shownName("node", …)` says it in another language. */
  labelDefault?: boolean;
  lastSeen: number;
  capabilities: Record<string, unknown>;
  /** Its Runner heard from within the last 30 seconds. */
  online?: boolean;
}
