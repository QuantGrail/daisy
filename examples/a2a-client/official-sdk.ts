/**
 * 用官方的 A2A JS SDK（@a2a-js/sdk 1.3）调用 Daisy 上的智能体。
 * Call an agent on a Daisy with the official A2A JS SDK (@a2a-js/sdk 1.3).
 *
 * Daisy 说标准的 A2A 1.0（JSON-RPC 和 HTTP+JSON 两种传输）。SDK 之外只多一件事：
 * 每个请求带一张调用方自己签的访问令牌（Authorization: Bearer）。这里用
 * @daisy-ai/a2a-client 的 signA2AToken 签（规则见 call-agent.ts 开头）；
 * 用别的语言时照同样的字段签一张 EdDSA JWT 即可。
 *
 * 和 call-agent.ts 的区别：SDK 用普通的 fetch，没有 Daisy 的出站规则；它只
 * 认证书机构签的证书（Daisy 自签名的直连地址连不上）；经中转时也不核对对方
 * 的 TLS 绑定声明，要信任中转的运营者。能用 call-agent.ts 时优先用它。
 *
 *   agentUrl = <Daisy 的地址>/a2a/<agentId>/      （结尾的 / 要有）
 */
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory } from "@a2a-js/sdk/client";
import { Role, TaskState } from "@a2a-js/sdk";
import type { ScriptIdentity } from "./call-agent.ts";

/** A fetch that adds a fresh access token for `aud` (the Daisy's identity URN) to every request. */
export function signingFetch(self: ScriptIdentity, aud: string): typeof fetch {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    headers.set("authorization", `Bearer ${await self.token(aud)}`);
    return fetch(input, { ...init, headers });
  };
}

export async function askWithSdk(o: {
  self: ScriptIdentity;
  /** The other Daisy's identity URN (from its card: readCard(text).urn). */
  aud: string;
  /** `<root>/a2a/<agentId>/` */
  agentUrl: string;
  text: string;
  /** Which transport to prefer: "JSONRPC" (default) or "HTTP+JSON". */
  binding?: "JSONRPC" | "HTTP+JSON";
}): Promise<{ state: string; text: string; taskId: string }> {
  const fetchImpl = signingFetch(o.self, o.aud);
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl }), new RestTransportFactory({ fetchImpl })],
    preferredTransports: [o.binding ?? "JSONRPC"],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  } as any);
  const client = await factory.createFromUrl(o.agentUrl);
  // Blocking by default: Daisy answers when the task is done or needs input.
  const res: any = await client.sendMessage({
    message: {
      messageId: crypto.randomUUID(),
      role: Role.ROLE_USER,
      parts: [{ content: { $case: "text", value: o.text } }],
    },
  } as any);
  const parts: any[] =
    res.status?.state === TaskState.TASK_STATE_COMPLETED
      ? (res.artifacts ?? []).flatMap((a: any) => a.parts ?? [])
      : (res.status?.message?.parts ?? []);
  const text = parts
    .map((p) => (p?.content?.$case === "text" ? p.content.value : ""))
    .filter(Boolean)
    .join("\n\n");
  return { state: TaskState[res.status?.state] ?? String(res.status?.state), text, taskId: res.id };
}
