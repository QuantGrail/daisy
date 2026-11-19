import { z } from "zod";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Store } from "../store/index.ts";
import type { RunnerPort } from "./runner-port.ts";
import { serve } from "./serve.ts";
import type { MessageKey } from "../../../contracts/src/i18n.ts";
import { LocalizedError } from "./errors.ts";
import { api } from "../../../contracts/src/api/index.ts";
const fail = (statusCode: number, code: string, key: MessageKey): never => {
  throw new LocalizedError(statusCode, code, key);
};
export function terminalRoutes(
  app: any,
  /** P1-02: the in-process Runner's calls (were /api/runner/*). */
  runner: RunnerPort,
  store: Store,
  session: (r: any, id: string) => any,
  ownedJob: (r: any) => any,
) {
  const check = (j: any) => {
    const o = store.one("SELECT data FROM job_operations WHERE job_id=?", j.id);
    if (!o || JSON.parse(o.data).name !== "terminal") fail(409, "not_terminal", "server-app.terminal.notTerminal");
    return j;
  };
  const owner = (req: any) => {
    const s = session(req, req.params.id),
      j = store.one(
        "SELECT * FROM jobs WHERE id=? AND session_id=?",
        req.params.jid,
        s.id,
      );
    if (!j) fail(404, "terminal_not_found", "server-app.terminal.notFound");
    return check(j);
  };
  const T = api.sessionTools;
  serve(app, T.terminalList, async (req: any) => {
    const s = session(req, req.params.id);
    const j = store.one(
      "SELECT j.id,j.status FROM jobs j JOIN job_operations o ON j.id=o.job_id WHERE j.session_id=? AND json_extract(o.data,'$.name')='terminal' ORDER BY j.created DESC LIMIT 1",
      s.id,
    );
    return { job: j || null };
  });
  serve(app, T.terminalOutput, async (req: any) => {
    const j = owner(req),
      after = T.terminalOutput.query.shape.after.parse(req.query.after || 0);
    const chunks = store.all(
      "SELECT part+1 AS seq,data FROM terminal_output WHERE job_id=? AND part>=? ORDER BY part LIMIT 100",
      j.id,
      after,
    );
    const first = store.one(
      "SELECT MIN(part)+1 AS n FROM terminal_output WHERE job_id=?",
      j.id,
    )?.n;
    return {
      chunks,
      status: j.status,
      truncated: first > after + 1,
    };
  });
  serve(app, T.terminalInput, async (req: any) => {
    const j = owner(req);
    if (!["queued", "running"].includes(j.status) || j.cancel)
      fail(409, "terminal_ended", "server-app.terminal.ended");
    const b = T.terminalInput.body.parse(req.body);
    if (
      store.one(
        "SELECT id FROM terminal_input WHERE id=? AND job_id=?",
        b.id,
        j.id,
      )
    )
      return { ok: true };
    if (
      store.one(
        "SELECT COUNT(*) AS n FROM terminal_input WHERE job_id=? AND status='queued'",
        j.id,
      ).n > 300
    )
      fail(429, "too_many_requests", "server-app.terminal.inputBacklog");
    store.run(
      "INSERT INTO terminal_input VALUES(?,?,?,?,?)",
      b.id,
      j.id,
      JSON.stringify(b),
      "queued",
      Date.now(),
    );
    return { ok: true };
  });
  runner.post("/jobs/:id/terminal/exchange", async (req: any) => {
    const j = check(ownedJob(req)),
      b = z
        .object({
          part: z.number().int().nonnegative(),
          data: z.string().max(100000).default(""),
        })
        .parse(req.body);
    return store.atomic(() => {
      if (b.data)
        store.run(
          "INSERT OR IGNORE INTO terminal_output(job_id,part,data) VALUES(?,?,?)",
          j.id,
          b.part,
          b.data,
        );
      // Bound the retained replay to 256 chunks (<= 16 MiB decoded).
      store.run(
        "DELETE FROM terminal_output WHERE job_id=? AND seq NOT IN (SELECT seq FROM terminal_output WHERE job_id=? ORDER BY seq DESC LIMIT 256)",
        j.id,
        j.id,
      );
      const inputs = store.all(
        "SELECT id,data FROM terminal_input WHERE job_id=? AND status='queued' ORDER BY created LIMIT 50",
        j.id,
      );
      for (const i of inputs)
        store.run(
          "UPDATE terminal_input SET status='dispatched' WHERE id=?",
          i.id,
        );
      // Dispatched keystrokes are never replayed after a lost response.
      store.run(
        "DELETE FROM terminal_input WHERE job_id=? AND status='dispatched' AND created<?",
        j.id,
        Date.now() - 600000,
      );
      return { inputs: inputs.map((i) => JSON.parse(i.data)) };
    });
  });
  const require = createRequire(import.meta.url);
  const assets: Record<string, [string, string]> = {
    "xterm.js": [require.resolve("@xterm/xterm"), "application/javascript"],
    "fit.js": [require.resolve("@xterm/addon-fit"), "application/javascript"],
    "xterm.css": [
      join(dirname(require.resolve("@xterm/xterm")), "../css/xterm.css"),
      "text/css",
    ],
    // Fixed terminal document for the web (CSP: no inline script).
    "terminal.html": [
      join(import.meta.dirname, "terminal-page/terminal.html"),
      "text/html; charset=utf-8",
    ],
    "terminal.js": [
      join(import.meta.dirname, "terminal-page/terminal.js"),
      "application/javascript",
    ],
  };
  app.get("/terminal-assets/:name", async (req: any, reply: any) => {
    const asset = assets[req.params.name];
    if (!asset) fail(404, "not_found", "server-app.terminal.assetNotFound");
    return reply
      .type(asset[1])
      .header("Cache-Control", "public,max-age=3600")
      .send(readFileSync(asset[0]));
  });
}
