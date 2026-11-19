// P5-05: a local socket path a test can listen on. Windows has no Unix
// sockets at file paths for Node — a named pipe (\\.\pipe\…) is its local
// socket, and http's socketPath takes it the same way.
import { createHash } from "node:crypto";
import { join } from "node:path";

export function sockPath(dir: string, name: string): string {
  if (process.platform !== "win32") return join(dir, name);
  const h = createHash("sha256").update(join(dir, name)).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\daisy-test-${h}-${name}`;
}
