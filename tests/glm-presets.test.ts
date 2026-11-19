import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GLM_MODEL_PIN,
  GLM_MODEL_SLOTS,
  OFFICIAL_MODEL_SLOTS,
  cleanModelSlots,
  glmModelPin,
  glmModelWarning,
  isGlmBaseUrl,
} from "../packages/contracts/src/index.ts";
import { isGlm } from "../packages/daisy/src/turns/quota.ts";
// P6-22: the shipped packs (and the process's default translator: Chinese in tests).
import { packT } from "./ui-pack.ts";

// The GLM presets, taken from the cc-switch project's presets.
const GLM = "https://open.bigmodel.cn/api/anthropic";

test("presets: GLM opus / sonnet / haiku with [1m] and no fable; official = Opus 5.5 (1M) in all four", () => {
  assert.deepEqual(cleanModelSlots({ ...GLM_MODEL_SLOTS, fable: "" }), {
    opus: "glm-5.3[1m]",
    sonnet: "glm-5.3-flash[1m]",
    haiku: "glm-5.3-flash[1m]",
  });
  assert.equal(GLM_MODEL_SLOTS.fable, undefined);
  for (const v of Object.values(GLM_MODEL_SLOTS)) assert.match(v!, /\[1m\]$/);
  assert.deepEqual(OFFICIAL_MODEL_SLOTS, {
    opus: "claude-opus-5-5[1m]",
    sonnet: "claude-opus-5-5[1m]",
    haiku: "claude-opus-5-5[1m]",
    fable: "claude-opus-5-5[1m]",
  });
});

test("GLM pin: empty or fable / mythos → opus[1m]; an opus or sonnet pin is kept", () => {
  assert.equal(GLM_MODEL_PIN, "opus[1m]");
  for (const m of ["", "  ", "fable", "claude-fable-5-1", "Mythos-1"])
    assert.equal(glmModelPin(m), "opus[1m]", m);
  for (const m of ["opus", "sonnet[1m]", "claude-opus-5-5[1m]", "glm-5.3[1m]"])
    assert.equal(glmModelPin(m), m);
});

test("warning: a GLM identity with a fable / mythos pin or a fable slot (the request would fail); none elsewhere", () => {
  assert.ok(
    isGlmBaseUrl(GLM) && isGlmBaseUrl("https://api.z.ai/api/anthropic"),
  );
  assert.ok(!isGlmBaseUrl("https://api.anthropic.com") && !isGlmBaseUrl(""));
  assert.equal(
    isGlm({ profile: { baseUrl: GLM } } as any),
    true,
    "the Runner uses the same test",
  );
  const pin = glmModelWarning({ baseUrl: GLM, model: "claude-fable-5-1" });
  assert.match(pin!, /顶层模型「claude-fable-5-1」.*请求会失败.*opus\[1m\]/);
  const slot = glmModelWarning({
    baseUrl: GLM,
    model: "",
    modelSlots: { fable: "claude-fable-5-1" },
  });
  assert.match(slot!, /fable 槽.*清空 fable 槽/);
  // English (the UI passes its own translator).
  assert.match(
    glmModelWarning({ baseUrl: GLM, model: "claude-fable-5-1" }, packT("en"))!,
    /^GLM has no fable \/ mythos model: the top-level model "claude-fable-5-1" .*Use opus\[1m\]/,
  );
  assert.match(
    glmModelWarning({ baseUrl: GLM, model: "", modelSlots: { fable: "x" } }, packT("en"))!,
    /clear the fable slot/,
  );
  assert.match(
    glmModelWarning({ baseUrl: GLM, model: "mythos", modelSlots: {} })!,
    /mythos/,
  );
  assert.equal(
    glmModelWarning({
      baseUrl: GLM,
      model: "opus[1m]",
      modelSlots: GLM_MODEL_SLOTS,
    }),
    null,
  );
  assert.equal(
    glmModelWarning({ baseUrl: GLM, model: "", modelSlots: { fable: " " } }),
    null,
    "an empty slot is no slot",
  );
  assert.equal(
    glmModelWarning({
      baseUrl: "https://api.anthropic.com",
      model: "claude-fable-5-1",
      modelSlots: OFFICIAL_MODEL_SLOTS,
    }),
    null,
    "only GLM",
  );
});
