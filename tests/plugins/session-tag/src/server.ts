/**
 * Test-only plugin (P4-13): nothing on the control-plane side but hook 3
 * (P6-14): a notification kind of its own, off by default, so the core's
 * tests see a plugin's kind offered (tests/notification-kinds.test.ts).
 */
import type { DaisyServerPlugin } from "@daisy-ai/daisy/plugin";

export function createServerPlugin(): DaisyServerPlugin {
  return {
    name: "session-tag",
    notificationKinds: [
      { id: "tag_review", label: "标签复核", hint: "测试插件的通知", default: false },
    ],
  };
}
