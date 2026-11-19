import { test } from "node:test";
import assert from "node:assert/strict";
import { blobBytes } from "../packages/ui/src/blob-bytes.ts";
test("attachments work with web Blobs and native Blobs without arrayBuffer", async () => {
  assert.deepEqual(
    [...(await blobBytes(new Blob([new Uint8Array([0, 1, 255])])))],
    [0, 1, 255],
  );
  const previous = globalThis.FileReader;
  try {
    (globalThis as any).FileReader = class {
      result = new Uint8Array([0, 255, 9]).buffer;
      onload = () => {};
      readAsArrayBuffer(blob: unknown) {
        assert.deepEqual(blob, { native: true });
        this.onload();
      }
    };
    assert.deepEqual(
      [...(await blobBytes({ native: true } as unknown as Blob))],
      [0, 255, 9],
    );
  } finally {
    globalThis.FileReader = previous;
  }
});
