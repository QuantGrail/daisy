// Web defaults for DaisyHostAdapters: plain DOM, no Expo modules required.
import type { DaisyClient } from "@daisy-ai/client";
import type { DaisyFileRequest, DaisyPickedFile } from "./host";

export function defaultPickFiles(): Promise<DaisyPickedFile[]> {
  if (typeof document === "undefined") return Promise.resolve([]);
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.style.display = "none";
  document.body.appendChild(input);
  return new Promise((resolve) => {
    const done = (files: DaisyPickedFile[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () =>
      done(
        Array.from(input.files || []).map((f) => ({
          name: f.name,
          mimeType: f.type || "application/octet-stream",
          size: f.size,
          blob: f,
        })),
      ),
    );
    input.addEventListener("cancel", () => done([]));
    input.click();
  });
}

export async function defaultSaveFile(
  file: DaisyFileRequest,
  _client: DaisyClient,
) {
  const blob = await file.read(),
    url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
