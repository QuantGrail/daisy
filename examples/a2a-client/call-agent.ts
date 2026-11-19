/**
 * 用 @daisy-ai/a2a-client 调用一个 Daisy 上的智能体（A2A 1.0）。
 * Call an agent on a Daisy over A2A 1.0 with @daisy-ai/a2a-client.
 *
 *   # 1. 生成自己的身份（Ed25519 私钥，0600）并打印身份名片，交给对方的 Daisy 主人导入
 *   node --import tsx examples/a2a-client/call-agent.ts card --key me.key.json --name "我的脚本"
 *
 *   # 2. 拿到对方 Daisy 导出的名片（daisy contact export），调用它的一个 agent
 *   node --import tsx examples/a2a-client/call-agent.ts call --key me.key.json \
 *        --card bob.daisycard [--agent <agentId>] "帮我看看这段报错"
 *
 * 做的事和 Daisy 自己、`daisy-mcp` 一样：每个请求签一张新的访问令牌
 * （iss = sub = 自己的身份 URN，aud = 对方的 URN，client_id a2a，
 * scope daisy:invoke，最长 5 分钟），先读 agent 目录和 agent 名片，再
 * SendMessage（returnImmediately），然后 GetTask 轮询到结束或对方要你补充信息。
 * 每个连接都走 a2a-client 的出站规则（不连本机回环、内网只限直连地址、
 * 不跟随重定向、大小和时间上限）；中转地址先核对对方的 TLS 绑定声明；
 * 没有证书机构担保的证书第一次见到时记下指纹，以后不一致就拒绝。
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CompactSign } from "jose";
import {
  A2APeer,
  IDENTITY_CARD_TYP,
  PeerError,
  answerOf,
  bindingVerifierFor,
  cardText,
  formsOfKey,
  makeCard,
  partsText,
  readCard,
  signA2AToken,
  type CardSigner,
  type IdentityCard,
  type IdentityForms,
  type OutboundPolicy,
  type TlsSeen,
} from "@daisy-ai/a2a-client";

/** This script's own identity: an Ed25519 key in a JSON file (the private JWK, mode 0600). */
export class ScriptIdentity implements CardSigner {
  readonly publicJwk: { kty: "OKP"; crv: "Ed25519"; x: string };
  readonly forms: IdentityForms;
  private constructor(private key: KeyObject) {
    const pub = createPublicKey(key).export({ format: "jwk" }) as { x: string };
    this.publicJwk = { kty: "OKP", crv: "Ed25519", x: pub.x };
    this.forms = formsOfKey(this.publicJwk);
  }

  /** Load the key, making it on first use. */
  static open(file: string): ScriptIdentity {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
      const { privateKey } = generateKeyPairSync("ed25519");
      writeFileSync(file, JSON.stringify(privateKey.export({ format: "jwk" })) + "\n", { mode: 0o600, flag: "wx" });
      text = readFileSync(file, "utf8");
    }
    return new ScriptIdentity(createPrivateKey({ key: JSON.parse(text), format: "jwk" }));
  }

  /** identity-card.md §2: the card's JWS, signed by this key. */
  signCard(payload: Record<string, unknown>): Promise<string> {
    return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "EdDSA", typ: IDENTITY_CARD_TYP })
      .sign(this.key);
  }

  /** The card to give the other owner: no address — nobody can call a script back. */
  async card(name: string): Promise<string> {
    return cardText(await makeCard(this, { name, addrs: [] }));
  }

  /** A fresh access token for one request to `aud` (the other Daisy's URN). */
  token(aud: string, act?: { sub: string; name?: string }): Promise<string> {
    return signA2AToken(this.key, { thumbprint: this.forms.thumbprint, aud, ttlS: 120, ...(act ? { act } : {}) });
  }
}

/** Trust on first use for certificates no CA vouches for (a Daisy's own self-signed one). */
export function pinStore(file: string | null) {
  const pins: Record<string, string> = {};
  if (file)
    try {
      Object.assign(pins, JSON.parse(readFileSync(file, "utf8")));
    } catch {}
  return (contactId: string, seen: TlsSeen): true | string => {
    const k = `${contactId} ${seen.origin}`;
    if (!pins[k]) {
      pins[k] = seen.fingerprint;
      if (file) writeFileSync(file, JSON.stringify(pins, null, 2) + "\n", { mode: 0o600 });
      return true;
    }
    return pins[k] === seen.fingerprint ? true : `${seen.origin} 的证书和第一次见到的不一样：先和对方核实`;
  };
}

export interface CallResult {
  agentId: string;
  agentName: string;
  /** TASK_STATE_* (or `message` when the other side answered with a message, not a task). */
  state: string;
  /** The answer, or the question when the state is TASK_STATE_INPUT_REQUIRED. */
  text: string;
  taskId: string | null;
  contextId: string | null;
}

const DONE = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED", "TASK_STATE_INPUT_REQUIRED"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callAgent(o: {
  self: ScriptIdentity;
  /** The other Daisy's identity card, verified (readCard). */
  contact: IdentityCard;
  /** Which agent; omitted: the only one this caller may see. */
  agentId?: string;
  text: string;
  /** Answer to an input-required question: the same task and context. */
  taskId?: string;
  contextId?: string;
  /** How long to wait for the answer (it keeps running on the other side). */
  waitMs?: number;
  tlsCheck?: (contactId: string, seen: TlsSeen) => true | string;
  /** Tests only: a Daisy on 127.0.0.1. Leave unset otherwise. */
  policy?: OutboundPolicy;
}): Promise<CallResult> {
  const { contact } = o;
  if (!contact.addrs.length) throw new Error(`${contact.name} 的名片上没有地址：不能被调用`);
  const tls = o.tlsCheck ?? pinStore(null);
  const verifier = bindingVerifierFor(contact.key, "relay", o.policy);
  let lastError: unknown = null;
  for (const addr of contact.addrs) {
    const peer = new A2APeer({
      root: addr.url,
      kind: addr.kind,
      token: () => o.self.token(contact.urn, { sub: "agent:example-script", name: "示例脚本" }),
      ...(o.policy ? { policy: o.policy } : {}),
      tlsCheck: (seen) => tls(contact.id, seen),
      binding: { verifier },
    });
    let agents;
    try {
      agents = await peer.directory();
    } catch (e) {
      // Offline at this address: try the next one (a relay address, a second direct one).
      if (e instanceof PeerError && e.kind === "unreachable") {
        lastError = e;
        continue;
      }
      throw e;
    }
    const agentId = o.agentId ?? (agents.length === 1 ? agents[0]!.agentId : null);
    if (!agentId)
      throw new Error(
        agents.length
          ? `对方对你开放了 ${agents.length} 个 agent，用 --agent 选一个：\n${agents.map((a) => `  ${a.agentId}  ${a.name}`).join("\n")}`
          : "对方没有对你开放的 agent",
      );
    const card = await peer.card(agentId);
    const sent = await peer.send(card, {
      message: {
        messageId: randomUUID(),
        role: "ROLE_USER",
        parts: [{ text: o.text }],
        ...(o.taskId ? { taskId: o.taskId } : {}),
        ...(o.contextId ? { contextId: o.contextId } : {}),
      },
      configuration: { returnImmediately: true, acceptedOutputModes: ["text/plain"] },
    });
    if ("message" in sent)
      return { agentId, agentName: card.name, state: "message", text: partsText(sent.message.parts), taskId: null, contextId: null };
    let task = sent.task;
    const until = Date.now() + (o.waitMs ?? 120_000);
    for (let wait = 300; !DONE.has(task.status.state) && Date.now() < until; wait = Math.min(wait * 2, 3000)) {
      await sleep(wait);
      task = await peer.getTask(card, task.id);
    }
    const state = task.status.state;
    const text =
      state === "TASK_STATE_COMPLETED" ? answerOf(task).text : partsText((task.status.message as any)?.parts) || state;
    return { agentId, agentName: card.name, state, text, taskId: task.id, contextId: task.contextId };
  }
  throw lastError ?? new Error("没有能连上的地址");
}

// ── the command line ─────────────────────────────────────────────────────

function flags(argv: string[]) {
  const out: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? "";
    else rest.push(a);
  }
  return { flags: out, rest };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...more] = argv;
  const { flags: f, rest } = flags(more);
  if (!f.key || (cmd !== "card" && cmd !== "call")) {
    process.stderr.write("用法：call-agent.ts card --key <文件> --name <名字>\n      call-agent.ts call --key <文件> --card <名片文件> [--agent <id>] <消息>\n");
    return 2;
  }
  const self = ScriptIdentity.open(f.key);
  if (cmd === "card") {
    process.stdout.write((await self.card(f.name || "A2A 示例脚本")) + "\n");
    return 0;
  }
  const contact = await readCard(readFileSync(f.card!, "utf8"));
  const r = await callAgent({
    self,
    contact,
    text: rest.join(" "),
    ...(f.agent ? { agentId: f.agent } : {}),
    ...(f.task ? { taskId: f.task } : {}),
    ...(f.context ? { contextId: f.context } : {}),
    tlsCheck: pinStore(`${f.key}.pins.json`),
  });
  process.stdout.write(`${r.agentName}（${r.state}）\n${r.text}\n`);
  if (r.state === "TASK_STATE_INPUT_REQUIRED")
    process.stdout.write(`\n回答它：再加 --task ${r.taskId} --context ${r.contextId}\n`);
  return r.state === "TASK_STATE_COMPLETED" || r.state === "TASK_STATE_INPUT_REQUIRED" || r.state === "message" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      process.stderr.write(`${e instanceof PeerError ? e.message + (e.more.remoteMessage ? `（对方说：${e.more.remoteMessage}）` : "") : String(e?.message ?? e)}\n`);
      process.exitCode = 1;
    },
  );
}
