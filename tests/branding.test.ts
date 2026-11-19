import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { HostBrandingSchema } from "../packages/contracts/src/index.ts";

const HOST = {
  name: "Acme Desk",
  copy: "tool-authorization",
  theme: {
    background: "#F5F6F8",
    surface: "#FFFFFF",
    text: "#151B26",
    mutedText: "#5D6878",
    border: "#E2E5EB",
    primary: "#4C5BD4",
    radius: 8,
    cardRadius: 12,
    fontFamily: 'Inter, "PingFang SC", sans-serif',
    agents: { claude: "#D97757" },
  },
} as const;

test("public /api/health serves validated host branding only when configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-brand-"));
  const plain = await createApp({ pinGate: false,
    dataDir: join(dir, "a"),
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  const branded = await createApp({ pinGate: false,
    dataDir: join(dir, "b"),
    workspaceHome: dir,
    workspaceRoots: [dir],
    branding: HOST,
  });
  try {
    const p = (await plain.app.inject({ url: "/api/health" })).json();
    assert.equal(p.ok, true);
    assert.equal("branding" in p, false);
    // Unauthenticated read: the web app needs it before login / host probe.
    const r = await branded.app.inject({ url: "/api/health" });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().branding, HOST);
  } finally {
    await plain.app.close();
    await branded.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid branding is refused at startup, not served", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-brand-bad-"));
  try {
    for (const bad of [
      { theme: { ...HOST.theme, primary: "indigo" } },
      { theme: { ...HOST.theme, fontFamily: "x; background:url(evil)" } },
      { theme: { ...HOST.theme, extra: "#000" } },
      { copy: "approve-everything" },
      { theme: { ...HOST.theme, density: 3 } },
      { unknown: true },
    ])
      await assert.rejects(
        createApp({ pinGate: false,
          dataDir: join(dir, String(Math.random())),
          workspaceHome: dir,
          workspaceRoots: [dir],
          branding: bad,
        }),
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("branding schema keeps the brand-token shape (#rgb/#rrggbb, optional extras)", () => {
  assert.equal(HostBrandingSchema.safeParse({}).success, true);
  assert.equal(HostBrandingSchema.safeParse({ copy: "default" }).success, true);
  assert.equal(
    HostBrandingSchema.safeParse({
      theme: { ...HOST.theme, primary: "#45d" },
    }).success,
    true,
  );
  assert.equal(
    HostBrandingSchema.safeParse({
      theme: { ...HOST.theme, primary: "#4C5BD4FF" },
    }).success,
    false,
  );
  assert.equal(
    HostBrandingSchema.safeParse({
      theme: { ...HOST.theme, agents: { gpt: "#000" } },
    }).success,
    false,
  );
  assert.equal(
    HostBrandingSchema.safeParse({ name: "x".repeat(41) }).success,
    false,
  );
});

test("workbench host fields: product name, marketing, lang, node settings, new work", async () => {
  const full = {
    ...HOST,
    productName: "雏菊",
    tagline: "",
    hideMarketing: true,
    lang: "zh-CN",
    hideNodeSettings: true,
    newWork: "hidden",
    theme: { ...HOST.theme, focusRing: "#4C5BD4" },
  };
  assert.equal(HostBrandingSchema.safeParse(full).success, true);
  assert.equal(
    HostBrandingSchema.safeParse({ requireTask: true }).success,
    true,
  );
  for (const bad of [
    { lang: "zh_CN" },
    { lang: "<x>" },
    { newWork: "maybe" },
    { hideMarketing: "yes" },
    { productName: "" },
    { productName: "x".repeat(41) },
    { theme: { ...HOST.theme, focusRing: "blue" } },
  ])
    assert.equal(
      HostBrandingSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
  // Served verbatim by the public health endpoint.
  const dir = mkdtempSync(join(tmpdir(), "daisy-brand-host-"));
  const { app } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    branding: full,
  });
  try {
    assert.deepEqual(
      (await app.inject({ url: "/api/health" })).json().branding,
      full,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("round-2 host fields: hostName, hostUrl, nodesHint, hideDeveloperInfo, hour12, status tokens; health lists DAISY_ORIGINS", async () => {
  const full = {
    ...HOST,
    productName: "雏菊",
    hostName: "Acme Desk",
    hostUrl: "/",
    taskUrl: "/tasks/{id}",
    nodesHint: "在 Acme Desk『我的执行节点』里管理",
    hideDeveloperInfo: true,
    hour12: false,
    theme: { ...HOST.theme, success: "#16A34A", neutral: "#5D6878" },
  };
  assert.equal(HostBrandingSchema.safeParse(full).success, true);
  for (const ok of [
    "/",
    "/tasks?x=1",
    "https://ui.example.com/",
    "http://127.0.0.1:18080/",
  ])
    assert.equal(
      HostBrandingSchema.safeParse({ hostUrl: ok }).success,
      true,
      ok,
    );
  for (const bad of [
    { hostUrl: "javascript:alert(1)" },
    { hostUrl: "//evil.example/" },
    { hostUrl: "/\\evil" },
    { hostUrl: "tasks" },
    { hostUrl: "data:text/html,x" },
    { hostUrl: "/a b" },
    { taskUrl: "/tasks/" },
    { taskUrl: "javascript:{id}" },
    { taskUrl: "//evil/{id}" },
    { hostName: "" },
    { hostName: "x".repeat(41) },
    { nodesHint: "x".repeat(121) },
    { hideDeveloperInfo: "yes" },
    { hour12: "no" },
    { theme: { ...HOST.theme, success: "green" } },
  ])
    assert.equal(
      HostBrandingSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
  const dir = mkdtempSync(join(tmpdir(), "daisy-brand-r2-"));
  const before = process.env.DAISY_ORIGINS;
  process.env.DAISY_ORIGINS =
    "https://ui.example.com,not-an-origin,https://x.example/path";
  const { app } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    branding: full,
  });
  try {
    const h = (await app.inject({ url: "/api/health" })).json();
    assert.deepEqual(h.branding, full);
    // Only well-formed origins (the same list the CSP frame-ancestors uses).
    assert.deepEqual(h.hostOrigins, ["https://ui.example.com"]);
  } finally {
    if (before === undefined) delete process.env.DAISY_ORIGINS;
    else process.env.DAISY_ORIGINS = before;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
