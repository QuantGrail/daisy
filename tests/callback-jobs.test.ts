/**
 * P6-12 (ADR-157): an external callback job is recognised by one generic
 * frame — `schedule:callback[-human]:<kind>:<item id>:<job>` — the same in
 * the scheduler (a stopped wake is kept), the live-append rules (read
 * after a stop: not kept again) and the queue (merge class). The core
 * knows no plugin's kinds or id shapes; a plugin builds its schedule id
 * through the public seam (`callbackScheduleId`), which refuses a kind or
 * item id the frame would not recognise. Shown with neutral shapes; the
 * private plugin's own ids are checked in its package's tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { callbackJob } from "../packages/daisy/src/schedule/callback-jobs.ts";
import { callbackScheduleId } from "@daisy-ai/daisy/plugin";

test("callbackJob: the generic frame, any kind and item id that fit it", () => {
  assert.deepEqual(callbackJob("schedule:callback:ping:PING-7:j1"), {
    scheduleId: "callback:ping:PING-7",
    human: false,
    kind: "ping",
    itemId: "PING-7",
  });
  assert.deepEqual(callbackJob("schedule:callback-human:review:r_2.b:j2"), {
    scheduleId: "callback-human:review:r_2.b",
    human: true,
    kind: "review",
    itemId: "r_2.b",
  });
  // 32-char kind, 64-char item id: the frame's limits.
  const kind = "k" + "-".repeat(31),
    item = "I".repeat(64);
  assert.equal(
    callbackJob(`schedule:callback:${kind}:${item}:j`)?.scheduleId,
    `callback:${kind}:${item}`,
  );
});

test("callbackJob: not a callback job", () => {
  for (const rid of [
    "",
    null,
    undefined,
    "schedule:cron:j",
    "schedule:kept-callbacks:j",
    "schedule:callback:ping:PING-7", // no job part
    "schedule:callback::PING-7:j", // no kind
    "schedule:callback:Ping:PING-7:j", // kind: lower case
    "schedule:callback:1ping:PING-7:j", // kind: starts with a letter
    `schedule:callback:${"k".repeat(33)}:x:j`, // kind: too long
    "schedule:callback:ping::j", // no item id
    "schedule:callback:ping:-x:j", // item id: starts with a letter or digit
    "schedule:callback:ping:a b:j", // item id: no spaces
    `schedule:callback:ping:${"I".repeat(65)}:j`, // item id: too long
    "schedule:callbacks:ping:PING-7:j",
    "chat:callback:ping:PING-7:j",
    "owner-approval:card-1",
  ])
    assert.equal(callbackJob(rid), null, String(rid));
});

test("callbackScheduleId (public seam): builds what callbackJob recognises; refuses what it would not", () => {
  assert.equal(callbackScheduleId("ping", "PING-7"), "callback:ping:PING-7");
  assert.equal(
    callbackScheduleId("ping", "PING-7", { human: true }),
    "callback-human:ping:PING-7",
  );
  for (const human of [false, true]) {
    const sid = callbackScheduleId("review", "r_2.b", { human });
    assert.deepEqual(callbackJob(`schedule:${sid}:j`), {
      scheduleId: sid,
      human,
      kind: "review",
      itemId: "r_2.b",
    });
  }
  for (const [kind, item] of [
    ["", "x"],
    ["Ping", "x"],
    ["a:b", "x"],
    ["k".repeat(33), "x"],
    ["ping", ""],
    ["ping", "a b"],
    ["ping", "x:y"],
    ["ping", "I".repeat(65)],
  ])
    assert.throws(() => callbackScheduleId(kind, item), /外部回调/);
});
