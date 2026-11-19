/**
 * P1-08: shared pieces of the browser tests — the Chrome to drive, and
 * the new way in (P1-03, ADR-110): no account, no password; the page is
 * opened with the link `daisy open` prints (a one-time code after `#code=`).
 */
const fs = require("node:fs");
const path = require("node:path");

/** CHROME_BIN, else the system Chrome of this OS. */
function chromePath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "darwin" && fs.existsSync(mac)) return mac;
  return "/usr/bin/google-chrome";
}

/**
 * `daisy open --print` (P1-07): the real command, with this Daisy's data
 * directory, prints the link with a one-time code; its last line is it.
 */
function daisyOpen(dataDir, env = process.env) {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, "..", "packages/daisy/bin/daisy.mjs"), "open", "--print"],
    { env: { ...env, DAISY_DATA: dataDir }, encoding: "utf8" },
  );
  const link = out
    .trim()
    .split("\n")
    .reverse()
    .find((l) => /^https?:\/\/\S+#code=/.test(l.trim()));
  if (!link) throw Error(`daisy open printed no link: ${out}`);
  return link.trim();
}

/** For the fixture backend (scripts/fixture-server.ts): its own `daisy open`. */
function openLink(info) {
  return `${info.url}/#code=${encodeURIComponent(info.code)}`;
}

async function waitForFile(file, ms, exited) {
  let gone = false;
  exited?.then(() => (gone = true));
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (gone) throw Error("the Daisy process exited early");
    if (Date.now() > end) throw Error(`gave up waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * P6-25 (ADR-159): these scripts find buttons and check text by the UI's
 * Chinese words, and the backend speaks the machine's language unless
 * told — so it is started in Chinese explicitly, on any machine.
 */
const E2E_LANG = "zh-CN";
/** The environment for a backend these scripts start: this process's, its language pinned, plus `extra`. */
function e2eEnv(extra = {}) {
  return { ...process.env, DAISY_LANG: E2E_LANG, ...extra };
}

module.exports = { chromePath, daisyOpen, openLink, waitForFile, e2eEnv, E2E_LANG };
