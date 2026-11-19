/**
 * P1-03 review H-1 (ADR-110): is the process at the other end of a
 * loopback connection the owner's? A page asking for a web session with
 * no one-time code (passcode off) gets one only when this says yes —
 * another system account on this machine (a service account the
 * shared-host check does not count) gets "passcode_required".
 *
 * - Linux: the client's socket in /proc/net/tcp (and tcp6, IPv4-mapped):
 *   local 127.0.0.1:<client port>, remote 127.0.0.1:<this face's port>;
 *   its uid column must be this process's uid.
 * - macOS: `lsof` — an ESTABLISHED TCP socket at 127.0.0.1:<client port>
 *   held by a process of this uid other than this one.
 * - Windows (P5-05): the helper's `tcp-owner` — the TCP table's owning
 *   process of the client end, and whether its token is this account's.
 * - Anything else, an error, a timeout, a request not on a real socket:
 *   false (the passcode is required). Fails closed.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Socket } from "node:net";
import { systemUid } from "./ports.ts";
import { runHelper } from "../platform/windows/helper.ts";

const hex4 = (port: number) => port.toString(16).toUpperCase().padStart(4, "0");
const LOOP4 = "0100007F";
const LOOP6_MAPPED = "0000000000000000FFFF00000100007F";

/**
 * The uid owning the client end `127.0.0.1:clientPort → 127.0.0.1:serverPort`
 * in a /proc/net/tcp{,6} table, or null.
 */
export function uidOfLoopbackClient(
  table: string,
  clientPort: number,
  serverPort: number,
): number | null {
  const want = [
    [`${LOOP4}:${hex4(clientPort)}`, `${LOOP4}:${hex4(serverPort)}`],
    [`${LOOP6_MAPPED}:${hex4(clientPort)}`, `${LOOP6_MAPPED}:${hex4(serverPort)}`],
  ];
  for (const line of table.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    const local = f[1]!.toUpperCase(),
      remote = f[2]!.toUpperCase();
    if (!want.some(([l, r]) => l === local && r === remote)) continue;
    const uid = Number(f[7]);
    return Number.isInteger(uid) ? uid : null;
  }
  return null;
}

/** `lsof -F p` output: some process (other than this one) was listed. */
export function lsofListedAProcess(stdout: string): boolean {
  return stdout.split("\n").some((l) => /^p\d+$/.test(l.trim()));
}

export function peerIsOwner(req: any, uid: number = systemUid()): boolean {
  try {
    const socket = req?.raw?.socket ?? req?.socket;
    if (!(socket instanceof Socket)) return false;
    if (socket.remoteAddress?.replace(/^::ffff:/, "") !== "127.0.0.1") return false;
    const clientPort = socket.remotePort,
      serverPort = socket.localPort;
    if (!clientPort || !serverPort) return false;
    if (process.platform === "linux") {
      for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        let table = "";
        try {
          table = readFileSync(f, "utf8");
        } catch {
          continue;
        }
        const owner = uidOfLoopbackClient(table, clientPort, serverPort);
        if (owner !== null) return owner === uid;
      }
      return false;
    }
    if (process.platform === "win32")
      return runHelper(["tcp-owner", String(clientPort), String(serverPort)], 3000).trim() === "owner";
    if (process.platform === "darwin") {
      const r = spawnSync(
        "lsof",
        [
          "-nP",
          "-a",
          "-u",
          String(uid),
          "-p",
          "^" + process.pid,
          "-iTCP@127.0.0.1:" + clientPort,
          "-sTCP:ESTABLISHED",
          "-Fp",
        ],
        { encoding: "utf8", timeout: 3000 },
      );
      if (r.error || r.signal) return false;
      return lsofListedAProcess(r.stdout || "");
    }
    return false;
  } catch {
    return false;
  }
}
