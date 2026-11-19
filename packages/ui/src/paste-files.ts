import type { DaisyPickedFile } from "./host";
import { t } from "./i18n";

/**
 * Pasted and dropped files for the composers:
 * a screenshot on the clipboard goes in with Ctrl+V / ⌘V, a file dragged
 * onto the composer with a drop — the same upload path, limits and pending
 * attachment row as the 「＋」 button. Pure (works on DataTransfer-like
 * objects) so it is unit tested; the composers wire the DOM events.
 */
interface ItemLike {
  kind: string;
  type: string;
  getAsFile(): Blob | null;
}
export interface TransferLike {
  items?: ArrayLike<ItemLike> | null;
  files?: ArrayLike<Blob> | null;
  types?: ArrayLike<string> | null;
}

/** Names a clipboard gives every image ("image.png"): replaced by ours. */
const GENERIC = /^(image|blob|clipboard|untitled|paste)?(\.\w{1,5})?$/i;
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
};
const pad = (n: number) => String(n).padStart(2, "0");

/** 「粘贴的图片-20261101-143205.png」 (local time; -2, -3… for more). */
export function pastedName(type: string, at: number, index = 0) {
  const d = new Date(at);
  const ext =
    EXT[type] ||
    (type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") ||
    "png";
  return (
    t("ui-chat.paste.imageName", {
      stamp:
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
        `${index ? "-" + (index + 1) : ""}`,
      ext,
    })
  );
}

function picked(blob: Blob, at: number, index: number): DaisyPickedFile {
  const given = (blob as Blob & { name?: string }).name || "";
  const type = blob.type || "application/octet-stream";
  return {
    name:
      given && !GENERIC.test(given)
        ? given
        : type.startsWith("image/")
          ? pastedName(type, at, index)
          : given || t("ui-chat.paste.attachment"),
    mimeType: type,
    size: blob.size,
    blob,
  };
}

/**
 * The images of a paste. Text (and HTML) is left to the browser: a paste of
 * an image and text uploads the image and pastes the text. Read it inside
 * the event (a DataTransfer is empty afterwards).
 */
export function pastedImages(
  data: TransferLike | null | undefined,
  at = Date.now(),
): DaisyPickedFile[] {
  if (!data) return [];
  const blobs: Blob[] = [];
  for (const item of Array.from(data.items || []))
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) blobs.push(f);
    }
  // Some browsers list clipboard files only under `files`.
  if (!blobs.length)
    for (const f of Array.from(data.files || []))
      if (f.type.startsWith("image/")) blobs.push(f);
  return blobs.map((b, i) => picked(b, at, i));
}

/** The files of a drop: any kind, like the attachment button. */
export function droppedFiles(
  data: TransferLike | null | undefined,
  at = Date.now(),
): DaisyPickedFile[] {
  if (!data) return [];
  let blobs = Array.from(data.files || []);
  if (!blobs.length)
    blobs = Array.from(data.items || [])
      .filter((x) => x.kind === "file")
      .map((x) => x.getAsFile())
      .filter((x): x is Blob => !!x);
  return blobs.map((b, i) => picked(b, at, i));
}

/** A drag carrying files (during dragover only the types can be read). */
export const dragHasFiles = (data: TransferLike | null | undefined) =>
  !!data && Array.from(data.types || []).includes("Files");
