// `npm run doctor` (a checkout): what this checkout's Daisy would use. P6-11:
// the data directory `npm start` uses (startDataDir), its runner.json start
// settings (before the harness table loads), and the local face where it
// really listens — the runtime file, else Daisy's own port rule — not a
// fixed port.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startDataDir } from "../packages/daisy/src/platform/paths.ts";
import { applyStartSettings } from "../packages/daisy/src/platform/settings.ts";
const root = resolve(import.meta.dirname, "..");
const dataDir = startDataDir(root).dir;
const settings = applyStartSettings(dataDir);
const { capabilities } = await import("../packages/daisy/src/turns/worker.ts");
const { PRODUCT_NAME } = await import("../packages/contracts/src/names.ts");
const { daisyEnv } = await import("../packages/contracts/src/env.ts");
const { ACP_HARNESS_PROBLEMS } = await import("../packages/contracts/src/acp-harnesses.ts");
const { readRuntime } = await import("../packages/daisy/src/cli/daisy.ts");
const { expectedLocalPort } = await import("../packages/daisy/src/access/ports.ts");
console.log(`${PRODUCT_NAME} diagnostics`);
console.log("Node", process.version);
console.log(
  "Web build",
  existsSync(resolve(root, "apps/app/dist/index.html"))
    ? "present"
    : "missing: npm run build:web",
);
console.log("Data directory", dataDir);
console.log(
  "Node config",
  existsSync(join(dataDir, "runner.json")) ? "present" : "not bootstrapped",
);
for (const p of [...settings.problems, ...ACP_HARNESS_PROBLEMS]) console.log("Settings problem", p);
console.log("CLIs", JSON.stringify(await capabilities(), null, 2));
// DAISY_SERVER_URL, else where this data directory's Daisy listens (its
// runtime file). Not running: the port a start would try — not asked, the
// port may be another Daisy's (another data directory of this account).
const given = daisyEnv("DAISY_SERVER_URL");
const url = given ? given.replace(/\/$/, "") : readRuntime(dataDir)?.local.url;
if (!url) {
  const { port, source } = expectedLocalPort(dataDir);
  console.log("Server", `not running for this data directory; a start would try port ${port} (${source})`);
} else
  try {
    const r = await fetch(url + "/api/health", { signal: AbortSignal.timeout(3000) });
    console.log("Server", url, r.status, await r.text());
  } catch {
    console.log("Server unavailable", url);
  }
console.log(
  "CLI login commands: claude auth login | codex login --device-auth | kimi login",
);
console.log("No credentials are displayed by this diagnostic.");
