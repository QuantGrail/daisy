// Native (iOS / Android) defaults for DaisyHostAdapters. Web uses platform.web.ts,
// which has no Expo or WebView dependency; bundlers pick it via the .web.* extension.
import { blobBytes } from "./blob-bytes";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import type { DaisyClient } from "@daisy-ai/client";
import type { DaisyFileRequest, DaisyPickedFile } from "./host";

export async function defaultPickFiles(): Promise<DaisyPickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return result.assets.map((a) => ({
    name: a.name,
    mimeType: a.mimeType || "application/octet-stream",
    size: a.size,
    readBase64: () => new File(a.uri).base64(),
  }));
}

export async function defaultSaveFile(
  file: DaisyFileRequest,
  client: DaisyClient,
) {
  const Sharing = await import("expo-sharing");
  if (file.text !== undefined) {
    const target = new File(Paths.cache, file.name);
    target.write(file.text);
    await Sharing.shareAsync(target.uri, {
      mimeType: file.mimeType,
      ...(file.mimeType === "application/json" ? { UTI: "public.json" } : {}),
    });
    return;
  }
  const blob = await file.read();
  const target = new File(
    Paths.cache,
    `daisy-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`,
  );
  target.write(await blobBytes(blob));
  await Sharing.shareAsync(target.uri, { mimeType: file.mimeType });
}
