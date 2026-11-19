/**
 * P5-03 tests: a paired device's session on the face a test can reach
 * with `app.inject` (the local face). Production pairs on the outside face
 * only (access/devices.ts DEVICE_FACES — the routes refuse the local one);
 * the guard's decisions for the `device` channel do not depend on the
 * face, so the every-route × every-caller matrix makes its device here:
 * a record as pairing writes it, and a session as trading its credential
 * does.
 */
import { randomBytes, createHash } from "node:crypto";
import { DEVICE_LIMITS } from "../../packages/contracts/src/limits.ts";

export function localDevice(ctx: any, name = "测试设备"): { id: string; token: string } {
  const id = "dev_" + randomBytes(9).toString("base64url");
  const secretHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  const now = Date.now();
  ctx.store.run(
    "INSERT INTO devices(id,name,secret_hash,face,created_at,created_by,last_used_at) VALUES(?,?,?,?,?,?,?)",
    id,
    name,
    secretHash,
    "local",
    now,
    "test",
    now,
  );
  const s = ctx.access.web.open("local", true, { device: id, ttlMs: DEVICE_LIMITS.sessionTtlMs, perDevice: DEVICE_LIMITS.sessionsPerDevice });
  return { id, token: s.token };
}
