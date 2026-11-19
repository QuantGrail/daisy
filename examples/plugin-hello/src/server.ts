/**
 * The control-plane half: `createServerPlugin` is called once at start
 * with its options (`plugins["example-hello"]` in runner.json, or {} when
 * enabled by DAISY_PLUGINS). It may return the hooks of DaisyServerPlugin
 * (`sessionPrompt`, `events`, `notificationKinds`); this one logs and
 * declares one notification kind, with its words in English and Chinese
 * (a reader sees their own language's, else English).
 */
import { log, type DaisyServerPlugin, type ServerPluginHost } from "@daisy-ai/daisy/plugin";

export function createServerPlugin(host: ServerPluginHost): DaisyServerPlugin {
  log.info(`example-hello: loaded (${Object.keys(host.options).length} option(s))`);
  return {
    name: "example-hello",
    notificationKinds: [
      {
        id: "hello_ping",
        label: { en: "Greeting", "zh-CN": "问候" },
        hint: { en: "The example plugin's greeting", "zh-CN": "例子插件的问候" },
        default: true,
      },
    ],
  };
}
