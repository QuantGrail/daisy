/**
 * P6-03 (ADR-153): the browser storage keys were `harbor.*` and are
 * `daisy.*`. A value kept under the old key is moved on first read: read
 * the new key; if absent, read the old one, write it under the new key and
 * remove the old one. Storage can refuse anything (a private window, a
 * full quota, no `window` at all): every access is guarded and a refusal
 * reads as "nothing kept".
 */
export type KeyValueStore = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem?(k: string): void;
};

/** The key a `daisy.*` key had before the rename. */
export const legacyStorageKey = (key: string): string =>
  key.replace(/^daisy\./, "harbor.");

/** The value under `key`, moving one kept under `legacy` (default: the `harbor.*` name). */
export function readMigrated(
  store: KeyValueStore | null | undefined,
  key: string,
  legacy: string = legacyStorageKey(key),
): string | null {
  if (!store) return null;
  try {
    const v = store.getItem(key);
    if (v !== null || legacy === key) return v;
    const old = store.getItem(legacy);
    if (old === null) return null;
    try {
      store.setItem(key, old);
      store.removeItem?.(legacy);
    } catch {
      /* cannot write: the old key stays and is read again next time */
    }
    return old;
  } catch {
    return null;
  }
}
