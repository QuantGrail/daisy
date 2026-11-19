/**
 * P4-04 (总纲 5.8, 5.10 「A2A 服务端」, 5.11 「外面来的」, D-26, D-27,
 * docs/contracts/a2a-usage.md, ADR-123): the A2A entry — one card and one
 * address per callable agent (`/a2a/<agentId>`), both transports.
 *
 * These are the only routes a visitor reaches (`visitors: true`): a
 * contact's cross-Daisy token or the external issuer's token for someone
 * else, scope `daisy:invoke`. The owner's channels and the AI are refused
 * (`visitors_only`); every other route refuses a visitor (`a2a_only`).
 * Whether the caller may see / call *this* agent (recognised, in its
 * range — P4-01 / P4-03) is decided in the handler: an agent they may not
 * see answers 404, as if it did not exist (T-3).
 *
 * Bodies are A2A 1.0 ProtoJSON (contracts/src/a2a.ts); the handler
 * validates them itself so every refusal is an A2A error of its transport
 * (a2a-usage.md §9). Streaming, task subscription, push notifications and
 * the extended card are declared unsupported on the card and answer the
 * spec's errors (P4-04 【建议】).
 */
import { z } from "zod";
import { exempt, group, json, route } from "./route.ts";
import type { A2ADirectory, A2ATask, ListTasksResult } from "../a2a.ts";

const CLI = exempt("api.a2a.exempt");
const aid = z.object({ aid: z.string() });
const aidTid = z.object({ aid: z.string(), tid: z.string() });
const visitor = { scope: "daisy:invoke", visitors: true, channels: [] } as const;

export const a2a = group("a2a", {
  directory: route({
    method: "GET",
    path: "/a2a",
    ...visitor,
    output: json<A2ADirectory>("A2ADirectory"),
    cli: CLI,
  }),
  card: route({
    method: "GET",
    path: "/a2a/:aid/.well-known/agent-card.json",
    params: aid,
    ...visitor,
    output: json("AgentCard"),
    cli: CLI,
  }),
  jsonrpc: route({
    method: "POST",
    path: "/a2a/:aid/jsonrpc",
    params: aid,
    ...visitor,
    output: json("api.output.jsonRpcResponse"),
    cli: CLI,
  }),
  send: route({
    method: "POST",
    path: "/a2a/:aid/message::send",
    params: aid,
    ...visitor,
    output: json<{ task: A2ATask }>("{ task: A2ATask }"),
    cli: CLI,
  }),
  stream: route({
    method: "POST",
    path: "/a2a/:aid/message::stream",
    params: aid,
    ...visitor,
    output: json("google.rpc.Status"),
    cli: CLI,
  }),
  listTasks: route({
    method: "GET",
    path: "/a2a/:aid/tasks",
    params: aid,
    ...visitor,
    output: json<ListTasksResult>("ListTasksResult"),
    cli: CLI,
  }),
  getTask: route({
    method: "GET",
    path: "/a2a/:aid/tasks/:tid",
    params: aidTid,
    ...visitor,
    output: json<A2ATask>("A2ATask"),
    cli: CLI,
  }),
  taskAction: route({
    method: "POST",
    path: "/a2a/:aid/tasks/:op",
    params: z.object({ aid: z.string(), op: z.string() }),
    ...visitor,
    output: json<A2ATask>("A2ATask"),
    cli: CLI,
  }),
  pushConfigList: route({
    method: "GET",
    path: "/a2a/:aid/tasks/:tid/pushNotificationConfigs",
    params: aidTid,
    ...visitor,
    output: json("google.rpc.Status"),
    cli: CLI,
  }),
  pushConfigCreate: route({
    method: "POST",
    path: "/a2a/:aid/tasks/:tid/pushNotificationConfigs",
    params: aidTid,
    ...visitor,
    output: json("google.rpc.Status"),
    cli: CLI,
  }),
  pushConfigGet: route({
    method: "GET",
    path: "/a2a/:aid/tasks/:tid/pushNotificationConfigs/:cid",
    params: z.object({ aid: z.string(), tid: z.string(), cid: z.string() }),
    ...visitor,
    output: json("google.rpc.Status"),
    cli: CLI,
  }),
  pushConfigDelete: route({
    method: "DELETE",
    path: "/a2a/:aid/tasks/:tid/pushNotificationConfigs/:cid",
    params: z.object({ aid: z.string(), tid: z.string(), cid: z.string() }),
    ...visitor,
    output: json("google.rpc.Status"),
    cli: CLI,
  }),
  extendedCard: route({
    method: "GET",
    path: "/a2a/:aid/extendedAgentCard",
    params: aid,
    ...visitor,
    output: json("google.rpc.Status"),
    cli: CLI,
  }),
});
