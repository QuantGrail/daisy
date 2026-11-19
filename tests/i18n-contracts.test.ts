/**
 * P6-23b (ADR-159): the shared contracts helpers the server, the command
 * line and the web UI all show — ACP harness texts, start-file rules,
 * the renamed-variable warning, A2A part limits — come from the packs and
 * follow the translator they are given.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks } from "../packages/contracts/src/i18n-node.ts";
import { ACP_HARNESSES, acpHarnessFromJson, harnessText, loadAcpHarnessFile } from "../packages/contracts/src/acp-harnesses.ts";
import { legacyEnvWarning } from "../packages/contracts/src/env.ts";
import { jsonErrorWhere, portRule, untrustedFile } from "../packages/contracts/src/start-files.ts";
import { bypassWarning } from "../packages/contracts/src/approvals.ts";
import { weakReadOnlyNote, A2AMessageSchema } from "../packages/contracts/src/a2a.ts";

const en = translator(shippedPacks(), "en"),
  zh = translator(shippedPacks(), "zh-CN");

test("P6-23b: a built-in harness's texts in either language; an owner-defined entry keeps its own words, its defaults name it", () => {
  const kimi = ACP_HARNESSES.kimi!;
  assert.match(harnessText(kimi, "description", en), /Kimi Code CLI over ACP/);
  assert.match(harnessText(kimi, "description", zh), /通过 ACP 接入 Kimi Code CLI/);
  assert.match(harnessText(kimi, "loginHint", en), /kimi login/);
  assert.match(harnessText(kimi, "quotaReason", en), /does not report quota/);
  assert.match(harnessText(kimi, "loginMessage", en), /authorization page/);
  assert.equal(harnessText(ACP_HARNESSES.opencode!, "loginMessage", en), "", "no in-Daisy login");
  const own = acpHarnessFromJson({ id: "acme", name: "Acme", description: "我自己的说明", launch: { command: "acme" } });
  assert.equal(harnessText(own, "description", en), "我自己的说明");
  assert.equal(harnessText(own, "install", en), "Install it as Acme's official instructions say");
  assert.equal(harnessText(own, "install", zh), "按 Acme 官方说明安装");
  assert.match(harnessText(own, "thresholdReason", en), /^Acme does not report its compaction threshold/);
});

test("P6-23b: the harness file's problems and the start-file rules in English", () => {
  const r = loadAcpHarnessFile(
    "/acp.json",
    () => JSON.stringify([{ id: "acme", launch: { command: "a" } }, { id: "Bad Id" }, { id: "kimi", launch: { command: "k" } }, { id: "x1", launch: { command: "./x" } }]),
    () => null,
    en,
  );
  assert.equal(r.entries.length, 1);
  assert.match(r.problems[0]!, /^ACP harness definition file \/acp\.json: entry 2 \(Bad Id\): invalid id: Bad Id; this entry was not loaded$/);
  assert.match(r.problems[1]!, /entry 3 \(kimi\): id already taken: kimi/);
  assert.match(r.problems[2]!, /launch\.command must be an absolute path or a command name/);
  assert.match(loadAcpHarnessFile("/b.json", () => "{", () => null, en).problems[0]!, /not valid JSON|JSON is not finished/);
  assert.match(loadAcpHarnessFile("/c.json", () => "{}", () => null, en).problems[0]!, /must be a JSON array/);
  assert.equal(portRule(en), "an integer from 1024 to 65535");
  assert.equal(portRule(zh), "1024–65535 之间的整数");
  assert.match(untrustedFile({ uid: 501, mode: 0o100664 }, 501, en)!, /other accounts can change it \(mode 0664/);
  assert.match(untrustedFile({ uid: 0, mode: 0o100600 }, 501, en)!, /does not belong to the account running Daisy/);
  assert.match(jsonErrorWhere(Object.assign(new Error("x"), { code: "EACCES" }), en), /cannot be read \(EACCES\)/);
});

test("P6-23b: the renamed-variable warning, the bypass warning, and the weak read-only note in both languages", () => {
  assert.equal(
    legacyEnvWarning("DAISY_BASE_PATH", en),
    "HARBOR_BASE_PATH is deprecated, use DAISY_BASE_PATH (the environment variable HARBOR_BASE_PATH was renamed to DAISY_BASE_PATH; please use the new name)",
  );
  assert.match(legacyEnvWarning("DAISY_BASE_PATH", zh), /环境变量 HARBOR_BASE_PATH 已改名为 DAISY_BASE_PATH/);
  assert.match(bypassWarning(en), /^Discouraged: skips every permission prompt/);
  assert.match(bypassWarning(zh), /^不鼓励/);
  assert.match(weakReadOnlyNote(en), /^Read-only guarantee: weak/);
  // The A2A part limits come from the packs too (the process's language: zh-CN in tests).
  const r = A2AMessageSchema.safeParse({ messageId: "m-12345678", role: "ROLE_USER", parts: [{ url: "https://x" }] });
  assert.equal(r.success, false);
  assert.ok(r.error!.issues.some((i) => /不接受 url 部件/.test(i.message)), JSON.stringify(r.error!.issues));
});

test("P6-23b: an ACP harness's login hint in a refusal follows Accept-Language", async () => {
  const { createApp } = await import("../packages/daisy/src/app.ts");
  const root = mkdtempSync(join(tmpdir(), "daisy-contracts-i18n-"));
  const dir = join(root, "data");
  mkdirSync(dir, { recursive: true });
  const ctx = await createApp({ dataDir: dir, workspaceHome: root, workspaceRoots: [root] });
  try {
    const h = { authorization: `Bearer ${ctx.issueToken()}` };
    const nodeId = (ctx as any).store.one("SELECT id FROM nodes LIMIT 1")?.id;
    assert.ok(nodeId, "the local node");
    const post = (lang: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/identities",
        headers: { ...h, "accept-language": lang },
        payload: { agent: "antigravity", nodeId, label: "x" },
      });
    let r = await post("en");
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().code, "login_unsupported");
    assert.match(r.json().error, /Run agy once in a terminal on this machine/);
    r = await post("zh-CN");
    assert.match(r.json().error, /在本机终端运行 agy 登录一次/);
  } finally {
    await ctx.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
