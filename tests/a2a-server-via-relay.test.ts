/**
 * P5-02 (总纲 7.6 P5-02 完成标志: 「原来直连的验收条目（N-5 和阶段 4 的 A 组）
 * 经中转再跑一遍，结果相同」): P4-04's A2A server tests — A-5, A-6, A-14,
 * A-15, A-16, the refusals, blocking, authorization, unsupported
 * operations, the per-caller limits — run again with every call going
 * through the relay program (in process, `relay.test`) to A's relay
 * address. Same file, same assertions (tests/a2a-server.test.ts).
 */
process.env.DAISY_TEST_A2A_VIA = "relay";
await import("./a2a-server.test.ts");
export {};
