import { randomUUID, createHash } from "node:crypto";
// Ids and token hashes (P1-00: moved from store.ts; P1-03: no passwords).
export const id = () => randomUUID();
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
