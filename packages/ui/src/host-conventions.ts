/**
 * P4-13: the conventions an embedding host shares with this
 * interface — its logout event, its secondary-sidebar toggle event, where a
 * sidebar's folded state is kept per browser, and the class names its
 * stylesheet gives the file-drop overlay. Daisy's own names by default; a
 * host passes its own once, before rendering (`setHostConventions`; a
 * host's adapter package says which).
 */
export interface HostConventions {
  /** `window` event: forget the kept conversation views (logout). */
  logoutEvent: string;
  /** `window` event: toggle the innermost secondary sidebar. */
  secondaryToggleEvent: string;
  /** localStorage key prefix of a sidebar's folded state (`<prefix><name>`). */
  sidebarKeyPrefix: string;
  /** Class prefix of the drop overlay (`<prefix>-overlay`, `-card`, `-title`, `-name`, `-note`). */
  dropClassPrefix: string;
}

export const DEFAULT_HOST_CONVENTIONS: Readonly<HostConventions> = Object.freeze({
  logoutEvent: "daisy:logout",
  secondaryToggleEvent: "daisy:toggle-secondary-sidebar",
  sidebarKeyPrefix: "daisy.sidebar.",
  dropClassPrefix: "daisy-drop",
});

let current: HostConventions = { ...DEFAULT_HOST_CONVENTIONS };
const listeners = new Set<(c: HostConventions) => void>();

/** What is in effect now. */
export function hostConventions(): Readonly<HostConventions> {
  return current;
}

/** A host's own names (the rest stay Daisy's). Returns what is in effect. */
export function setHostConventions(
  c: Partial<HostConventions>,
): Readonly<HostConventions> {
  const next = { ...current };
  for (const k of Object.keys(DEFAULT_HOST_CONVENTIONS) as (keyof HostConventions)[])
    if (typeof c[k] === "string" && c[k]) next[k] = c[k]!;
  current = next;
  for (const l of listeners) l(current);
  return current;
}

/** Called now and whenever a host changes them. */
export function onHostConventions(l: (c: HostConventions) => void): () => void {
  listeners.add(l);
  l(current);
  return () => listeners.delete(l);
}
