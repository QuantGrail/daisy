import { t } from "./i18n";
/** React Native Blob lacks arrayBuffer(); use its supported FileReader bridge. */
export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function")
    return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(new Uint8Array(reader.result))
        : reject(Error(t("ui-chat.attachment.readFailed")));
    reader.onerror = () => reject(reader.error || Error(t("ui-chat.attachment.readFailed")));
    reader.onabort = () => reject(Error(t("ui-chat.attachment.readCancelled")));
    reader.readAsArrayBuffer(blob);
  });
}
