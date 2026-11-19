/**
 * P5-03 (ADR-142, review M-2): what a paired device keeps — its id, its
 * device credential, its name, and the address of the Daisy it paired
 * with. The credential is only ever sent to that address (never to the
 * app's build-time default or any other origin); a kept record without
 * one (written before this rule) is not used.
 */
export interface PairedDevice {
  id: string;
  secret: string;
  name: string;
  /** The Daisy's base URL the device paired with (the outside face: its listener, or the relay address — P5-03b). */
  url: string;
}

export function parsePairedDevice(text: string | null | undefined): PairedDevice | null {
  if (!text) return null;
  try {
    const d = JSON.parse(text);
    if (!d || typeof d.id !== "string" || typeof d.secret !== "string" || typeof d.url !== "string") return null;
    const u = new URL(d.url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { id: d.id, secret: d.secret, name: typeof d.name === "string" ? d.name : "", url: d.url.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

/** An address without its trailing slashes (the way `DaisyClient` keeps it). */
const bare = (u: string) => u.replace(/\/+$/, "");

/**
 * P6-26 review M-1: forget the stored device only when it is still `device`
 * (the same id and credential). Another tab may have paired this browser
 * anew meanwhile — a stale tab giving up its old device must not erase the
 * new credential. Returns whether it was forgotten.
 */
export function forgetPairedDevice(
  storage: { getItem(k: string): string | null; removeItem(k: string): void },
  key: string,
  device: Pick<PairedDevice, "id" | "secret">,
): boolean {
  const kept = parsePairedDevice(storage.getItem(key));
  if (!kept || kept.id !== device.id || kept.secret !== device.secret) return false;
  storage.removeItem(key);
  return true;
}

/**
 * P6-26 review L-1: the stored device, when it paired with the Daisy of this
 * page (several Daisys under one origin — sub-path deployments — share the
 * origin's storage); otherwise none.
 */
export function pairedDeviceForPage(device: PairedDevice | null, pageUrl: string): PairedDevice | null {
  return device && bare(device.url) === bare(pageUrl) ? device : null;
}

/**
 * P6-26 review L-1: the page's kept session (`{url, token}`) as the device's
 * Bearer only when it was kept for the device's address; otherwise "".
 */
export function keptSessionToken(kept: string | null | undefined, deviceUrl: string): string {
  if (!kept) return "";
  try {
    const k = JSON.parse(kept);
    return typeof k?.url === "string" && typeof k.token === "string" && bare(k.url) === bare(deviceUrl) ? k.token : "";
  } catch {
    return "";
  }
}
