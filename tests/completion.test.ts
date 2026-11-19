import { test } from "node:test";
import assert from "node:assert/strict";
import { reportCompletion } from "../packages/daisy/src/turns/completion.ts";
test("lost completion receipt retries the same acknowledgment; revoked credentials are not retried", async () => {
  let calls = 0;
  const waits: number[] = [];
  const result = await reportCompletion(
    async () => {
      if (++calls < 3) throw Error("connection lost");
      return { ok: true };
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1000]);
  calls = 0;
  await assert.rejects(
    () =>
      reportCompletion(
        async () => {
          calls++;
          throw Object.assign(Error("revoked"), { status: 403 });
        },
        async () => {},
      ),
    /revoked/,
  );
  assert.equal(calls, 1);
});
