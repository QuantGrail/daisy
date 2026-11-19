/**
 * P5-04: the terminal window's PTY bridge (packages/daisy/src/turns/
 * terminal-pty.py) on Linux and macOS: a real terminal (tty, window size
 * and resizes), typed input reaches the program, its exit code comes
 * back, and stopping ends the program's whole group. macOS's pty returns
 * EOF where Linux raises EIO when the program exits — both end the loop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BRIDGE = fileURLToPath(new URL("../packages/daisy/src/turns/terminal-pty.py", import.meta.url));
const SKIP = { skip: process.platform === "win32" ? "Windows 的伪终端是 P5-05 的" : false, timeout: 20_000 };

function bridge(argv: string[]) {
  const child = spawn("python3", [BRIDGE, ...argv], { stdio: ["pipe", "pipe", "pipe"], detached: true });
  let text = "";
  let buf = "";
  child.stdout!.on("data", (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      text += Buffer.from(JSON.parse(line).data, "base64").toString("utf8");
    }
  });
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const until = async (re: RegExp) => {
    for (let i = 0; i < 200 && !re.test(text); i++) await new Promise((r) => setTimeout(r, 25));
    assert.match(text, re);
  };
  const send = (o: object) => child.stdin!.write(JSON.stringify(o) + "\n");
  return { child, exited, until, send, text: () => text };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("terminal PTY: a real tty, its size and resizes, typed input, the exit code", SKIP, async () => {
  // Each answer on its own labelled line: Ubuntu 26.04's Rust coreutils
  // `tty` prints the name without a newline.
  const b = bridge(["/bin/sh", "-c", 'read x; echo "size=$(stty size)"; echo "tty=$(tty)"; echo "[$x]"; exit 7']);
  b.send({ cols: 120, rows: 40 });
  b.send({ text: "hello\n" });
  await b.until(/\[hello\]/);
  assert.match(b.text(), /^size=40 120\r?$/m, `the window size the page asked for: ${JSON.stringify(b.text())}`);
  assert.match(b.text(), /^tty=\/dev\/(pts\/\d+|ttys\d+)\r?$/m, `a real terminal (Linux /dev/pts, macOS /dev/ttys): ${JSON.stringify(b.text())}`);
  assert.equal(await b.exited, 7);
});

test("terminal PTY: stopping (SIGTERM) ends the program and its children, exit 143", SKIP, async () => {
  const b = bridge(["/bin/sh", "-c", 'sleep 60 & echo "child=$!"; wait']);
  await b.until(/child=\d+/);
  const child = Number(/child=(\d+)/.exec(b.text())![1]);
  assert.ok(alive(child));
  b.child.kill("SIGTERM");
  assert.equal(await b.exited, 143);
  for (let i = 0; i < 40 && alive(child); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(child), false, "the program's group is gone");
});
