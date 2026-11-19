import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COMMAND_NAME,
  DATA_DIR_NAME,
  EXTENSION_ID_PREFIX,
  LOG_PREFIX,
  PRODUCT_NAME,
  SCOPE_PREFIX,
  scopeName,
} from "../packages/contracts/src/index.ts";

test("P0-06: the product's names come from one place", () => {
  assert.equal(PRODUCT_NAME, "Daisy");
  assert.equal(COMMAND_NAME, "daisy");
  assert.equal(SCOPE_PREFIX, "daisy:");
  assert.equal(scopeName("session:read"), "daisy:session:read");
  assert.equal(DATA_DIR_NAME, "daisy"); // 待 ADR-102 确认
  assert.ok(EXTENSION_ID_PREFIX.startsWith(`urn:${COMMAND_NAME}:`));
  assert.equal(LOG_PREFIX, `[${COMMAND_NAME}]`);
  // The interface's default wording and tab title take it from there
  // (read as source: the UI modules load react-native).
  assert.match(
    readFileSync("packages/ui/src/host.tsx", "utf8"),
    /productName: PRODUCT_NAME,/,
  );
  assert.match(
    readFileSync("packages/ui/src/branding.ts", "utf8"),
    /branding\.productName \|\| PRODUCT_NAME;/,
  );
});

test("P0-06: the app manifest (JSON, cannot import) names the same product", () => {
  const { expo } = JSON.parse(readFileSync("apps/app/app.json", "utf8"));
  assert.equal(expo.name, PRODUCT_NAME);
  assert.equal(expo.web.name, PRODUCT_NAME);
  assert.equal(expo.web.shortName, PRODUCT_NAME);
});
