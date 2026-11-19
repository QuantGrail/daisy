import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";

test("HTML responses carry a strict CSP; the terminal page has no inline script", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-csp-")),
    web = join(dir, "web");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>x</title>");
  const old = process.env.DAISY_ORIGINS;
  process.env.DAISY_ORIGINS = "https://deck.example.com,bad origin;x";
  const { app } = await createApp({ pinGate: false,
    dataDir: join(dir, "data"),
    webDir: web,
    bootstrapLocal: false,
  });
  try {
    const policy = (h: any) =>
      Object.fromEntries(
        String(h["content-security-policy"] || "")
          .split(";")
          .map((x) => x.trim().split(/\s+/))
          .filter((x) => x[0])
          .map(([k, ...v]) => [k, v]),
      );
    for (const url of ["/", "/index.html", "/some/spa/route"]) {
      const r = await app.inject({ url });
      assert.equal(r.statusCode, 200, url);
      const p = policy(r.headers);
      assert.deepEqual(p["script-src"], ["'self'"], url);
      assert.deepEqual(p["connect-src"], ["'self'"], url);
      assert.deepEqual(p["default-src"], ["'self'"], url);
      assert.deepEqual(p["base-uri"], ["'none'"], url);
      assert.deepEqual(p["object-src"], ["'none'"], url);
      // Framing: same origin plus valid DAISY_ORIGINS entries only.
      assert.deepEqual(
        p["frame-ancestors"],
        ["'self'", "https://deck.example.com"],
        url,
      );
    }
    // JSON API responses are not HTML and need no policy.
    const health = await app.inject({ url: "/api/health" });
    assert.equal(health.headers["content-security-policy"], undefined);
    const term = await app.inject({ url: "/terminal-assets/terminal.html" });
    assert.equal(term.statusCode, 200);
    assert.match(String(term.headers["content-type"]), /text\/html/);
    assert.deepEqual(policy(term.headers)["script-src"], ["'self'"]);
    // Every <script> is external; nothing user-controlled is interpolated.
    const scripts = term.body.match(/<script[^>]*>/g) || [];
    assert.ok(scripts.length >= 3);
    for (const s of scripts) assert.match(s, /src="[a-z]+\.js"/);
    assert.doesNotMatch(term.body, /<script>\s*\S/);
    const js = await app.inject({ url: "/terminal-assets/terminal.js" });
    assert.equal(js.statusCode, 200);
    // The token is only accepted from the parent frame via postMessage.
    assert.match(js.body, /e\.source !== window\.parent/);
    assert.doesNotMatch(js.body, /q\.get\("token"\)/);
  } finally {
    if (old === undefined) delete process.env.DAISY_ORIGINS;
    else process.env.DAISY_ORIGINS = old;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
