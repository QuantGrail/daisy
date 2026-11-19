// Pasted / dropped files for the composers:
// packages/ui/src/paste-files.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dragHasFiles,
  droppedFiles,
  pastedImages,
  pastedName,
} from "../packages/ui/src/paste-files.ts";
import { inUiLang, uiLang } from "./ui-pack.ts";

// P6-22 (ADR-159 §8): the UI speaks Chinese here (the assertions are Chinese).
uiLang("zh-CN");

const at = new Date(2026, 10, 1, 14, 32, 5).getTime();
const file = (name: string, type: string, size = 3) =>
  new File([new Uint8Array(size)], name, { type });
const item = (kind: string, type: string, f: Blob | null = null) => ({
  kind,
  type,
  getAsFile: () => f,
});

test("a screenshot on the clipboard becomes an image file to upload", () => {
  const png = file("image.png", "image/png", 1200);
  const out = pastedImages({ items: [item("file", "image/png", png)] }, at);
  assert.equal(out.length, 1);
  assert.equal(out[0].blob, png);
  assert.equal(out[0].mimeType, "image/png");
  assert.equal(out[0].size, 1200);
  // "image.png" says nothing: a dated name instead.
  assert.equal(out[0].name, "粘贴的图片-20261101-143205.png");
});

test("text is left to the browser; image + text uploads only the image", () => {
  assert.deepEqual(
    pastedImages({ items: [item("string", "text/plain")] }, at),
    [],
  );
  const jpg = file("photo of the board.jpg", "image/jpeg");
  const out = pastedImages(
    {
      items: [
        item("string", "text/plain"),
        item("string", "text/html"),
        item("file", "image/jpeg", jpg),
      ],
    },
    at,
  );
  assert.deepEqual(
    out.map((f) => f.name),
    ["photo of the board.jpg"],
    "a real name is kept",
  );
});

test("non-image clipboard files are not pasted as attachments", () => {
  const pdf = file("report.pdf", "application/pdf");
  assert.deepEqual(
    pastedImages({ items: [item("file", "application/pdf", pdf)] }, at),
    [],
  );
  assert.deepEqual(pastedImages(null), []);
  assert.deepEqual(pastedImages({}), []);
});

test("browsers that list clipboard images only under files", () => {
  const a = file("image.png", "image/png"),
    b = file("blob", "image/webp");
  const out = pastedImages({ items: [], files: [a, b] }, at);
  assert.deepEqual(
    out.map((f) => f.name),
    ["粘贴的图片-20261101-143205.png", "粘贴的图片-20261101-143205-2.webp"],
  );
});

test("a drop takes every file (like the 「＋」 button) and needs Files", () => {
  const png = file("chart.png", "image/png"),
    csv = file("prices.csv", "text/csv");
  assert.deepEqual(
    droppedFiles({ files: [png, csv] }, at).map((f) => [f.name, f.mimeType]),
    [
      ["chart.png", "image/png"],
      ["prices.csv", "text/csv"],
    ],
  );
  // Items only (no files list).
  assert.equal(
    droppedFiles({ items: [item("file", "text/csv", csv)] }, at).length,
    1,
  );
  // A dragged text selection is not a file.
  assert.deepEqual(droppedFiles({ files: [], items: [] }, at), []);
  assert.equal(dragHasFiles({ types: ["text/plain"] }), false);
  assert.equal(dragHasFiles({ types: ["Files", "text/uri-list"] }), true);
  assert.equal(dragHasFiles(null), false);
});

test("pasted names", () => {
  assert.equal(pastedName("image/jpeg", at), "粘贴的图片-20261101-143205.jpg");
  assert.equal(
    pastedName("image/gif", at, 2),
    "粘贴的图片-20261101-143205-3.gif",
  );
  assert.equal(
    pastedName("image/svg+xml", at),
    "粘贴的图片-20261101-143205.svg",
  );
  // P6-22: the name follows the UI's language.
  inUiLang("en", () =>
    assert.equal(pastedName("image/png", at), "pasted-image-20261101-143205.png"),
  );
});
