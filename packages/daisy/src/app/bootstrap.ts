import { AGENT_IDS } from "../../../contracts/src/acp-harnesses.ts";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, parse } from "node:path";
import { id, hash } from "../store/index.ts";
import { OWNER_ID } from "../access/owner.ts";
import type { AppContext } from "./context.ts";
/**
 * First start, an empty database (P1-00: moved from app.ts): unless
 * bootstrapLocal is off, this machine's Runner (the one `nodes` row), its
 * workspace, host-login identities and runner.json (the in-process
 * Runner's settings — P1-02: no server URL or token, it calls in
 * process). P1-03: no admin account and no ACCESS.md — the owner is the
 * system account; the command line's credential is keys/cli-credential.
 */
export function bootstrapFirstStart(ctx: AppContext): void {
  const { opts, store } = ctx;
  if (
    opts.bootstrap === false ||
    opts.bootstrapLocal === false ||
    store.one("SELECT id FROM nodes LIMIT 1")
  )
    return;
  // P1-02: no node token any more (the column stays; nothing reads it).
  const nid = id(),
    nodeToken = randomBytes(32).toString("base64url");
  const root = resolve(opts.workspaceHome || homedir());
  mkdirSync(root, { recursive: true });
  store.run(
    "INSERT INTO nodes(id,label,token_hash) VALUES(?,?,?)",
    nid,
    // P6-28: Daisy's own names are stored unnamed ("") and said in the
    // reader's language when shown (platform/default-names.ts).
    "",
    hash(nodeToken),
  );
  const wid = id();
  store.run(
    "INSERT INTO workspaces VALUES(?,?,?,?)",
    wid,
    nid,
    "",
    root,
  );
  // P4-10: a host-login identity per agent, every ACP harness included
  // (P6-11: the same step as every later start, ensureHostLogins).
  ensureHostLogins(ctx, nid);
  // P6-11: settings the owner wrote before the first start (`port`,
  // `acpHarnesses`, `agentBins`, `plugins` …) are kept.
  let before: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(join(opts.dataDir, "runner.json"), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) before = raw;
  } catch {}
  writeFileSync(
    join(opts.dataDir, "runner.json"),
    JSON.stringify(
      {
        ...before,
        nodeId: nid,
        allowedRoots: opts.workspaceRoots || [parse(root).root],
        workspaceHome: root,
        concurrency: 8,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

/**
 * P6-11 (ADR-156): every start, a host-login identity (this machine's own
 * login of the CLI) on this machine's node for each agent that has not had
 * one — a harness that appeared after the first start (an extra ACP
 * harness file, a new built-in) gets it as the first start would have
 * given it; one the owner deleted is not made again (host_login_agents
 * remembers). The node is runner.json's (the in-process Runner's).
 */
export function ensureHostLogins(
  ctx: AppContext,
  nodeId?: string,
  agents: readonly string[] = AGENT_IDS,
): string[] {
  const { opts, store } = ctx;
  if (opts.bootstrap === false || opts.bootstrapLocal === false) return [];
  let nid = nodeId;
  if (!nid)
    try {
      nid = JSON.parse(readFileSync(join(opts.dataDir, "runner.json"), "utf8"))?.nodeId;
    } catch {
      return [];
    }
  if (typeof nid !== "string" || !store.one("SELECT id FROM nodes WHERE id=? AND revoked_at=0", nid)) return [];
  const made: string[] = [];
  store.atomic(() => {
    for (const agent of agents) {
      if (store.one("SELECT agent FROM host_login_agents WHERE node_id=? AND agent=?", nid, agent)) continue;
      const pid = id();
      store.run(
        "INSERT INTO profiles VALUES(?,?,?,?,?)",
        pid,
        OWNER_ID,
        nid,
        JSON.stringify({
          id: pid,
          ownerId: OWNER_ID,
          nodeId: nid,
          agent,
          // P6-28: unnamed — "<harness> · host login" in the reader's language.
          label: "",
          authMode: "subscription",
          model: "",
          baseUrl: "",
          configDir: "",
        }),
        "",
      );
      store.run("INSERT INTO host_login_agents(node_id,agent,created_at) VALUES(?,?,?)", nid, agent, Date.now());
      made.push(agent);
    }
  });
  return made;
}
