import type { DaisyPickedFile } from "./host";
import { t } from "./i18n";
/** Base64 (without the data: prefix) of a Blob; FileReader exists on web and React Native. */
export function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error || Error(t("ui-chat.file.readFailed")));
    reader.readAsDataURL(blob);
  });
}
export async function pickedBase64(file: DaisyPickedFile) {
  if (file.base64 !== undefined) return file.base64;
  if (file.blob) return blobToBase64(file.blob);
  if (file.readBase64) return file.readBase64();
  throw Error(t("ui-chat.file.cannotRead", { name: file.name }));
}
