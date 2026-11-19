import { z } from "zod";
import { randomBytes } from "node:crypto";
import { id, type Store } from "../store/index.ts";
import type { RunnerPort } from "./runner-port.ts";
import { api } from "../../../contracts/src/api/index.ts";
import { requestT } from "./language.ts";
import { serve } from "./serve.ts";
import {
  ACP_LOGIN_HOSTS,
  acpHarness,
  harnessText,
} from "../../../contracts/src/acp-harnesses.ts";
import type { MessageKey } from "../../../contracts/src/i18n.ts";
import { LocalizedError, type MsgParams } from "./errors.ts";
const fail = (statusCode: number, code: string, key: MessageKey, params?: MsgParams): never => {
  throw new LocalizedError(statusCode, code, key, params);
};
export function authRoutes(
  app: any,
  /** P1-02: the in-process Runner's calls (were /api/runner/*). */
  runner: RunnerPort,
  store: Store,
  user: (r: any) => any,
  node: (r: any) => any,
  usableNode: (u: any, nodeId: string) => any,
  claimingNode: (r: any) => any = node,
) {
  const reap = () =>
    store.run(
      "UPDATE logins SET status='expired',data='{}',input='' WHERE status IN ('queued','running','waiting') AND (expires<? OR (lease_until>0 AND lease_until<?))",
      Date.now(),
      Date.now(),
    );
  const view = (r: any) => ({
    id: r.id,
    profileId: r.profile_id,
    status: r.status,
    expiresAt: r.expires,
    ...JSON.parse(r.data),
  });
  const own = (req: any) => {
    const u = user(req);
    reap();
    const r = store.one("SELECT * FROM logins WHERE id=?", req.params.id);
    if (!r || r.owner_id !== u.id) fail(404, "login_not_found", "server-app.login.notFound");
    return r;
  };
  const leased = (req: any) => {
    const n = node(req);
    reap();
    const r = store.one("SELECT * FROM logins WHERE id=?", req.params.id);
    if (
      !r ||
      r.node_id !== n.id ||
      r.lease !== req.headers["x-lease"] ||
      !["running", "waiting"].includes(r.status)
    )
      fail(409, "login_lease_expired", "server-app.login.leaseExpired");
    return r;
  };
  const P = api.profiles;
  serve(app, P.createManaged, async (req: any) => {
    const u = user(req),
      b = P.createManaged.body.parse(req.body);
    usableNode(u, b.nodeId);
    // P4-10: an ACP harness needs a relocatable CLI directory and an
    // in-Daisy login for an identity of its own (acp-harnesses.ts).
    const acp = acpHarness(b.agent);
    if (acp && (!acp.configDir || !acp.login))
      fail(400, "login_unsupported", "server-app.login.acpNoManaged", { name: acp.name, agent: acp.id, hint: harnessText(acp, "loginHint", requestT(req)) });
    const pid = id(),
      p = {
        id: pid,
        ownerId: u.id,
        ...b,
        authMode: "subscription",
        model: "",
        baseUrl: "",
        configDir: `managed:${pid}`,
      };
    store.run(
      "INSERT INTO profiles VALUES(?,?,?,?,?)",
      pid,
      u.id,
      b.nodeId,
      JSON.stringify(p),
      "",
    );
    store.audit(u.id, "identity.create", pid);
    return { ...p, hasSecret: false };
  });
  serve(app, P.loginStart, async (req: any) => {
    const u = user(req);
    reap();
    const row = store.one(
      "SELECT * FROM profiles WHERE id=? AND owner_id=?",
      req.params.id,
      u.id,
    );
    if (!row) fail(404, "profile_not_found", "server-app.profile.notFound");
    const p = JSON.parse(row.data);
    const n = store.one("SELECT revoked_at FROM nodes WHERE id=?", p.nodeId);
    if (!n || n.revoked_at) fail(409, "node_revoked", "server-app.login.nodeRevoked");
    if (p.authMode !== "subscription" || p.configDir !== `managed:${p.id}`)
      fail(400, "login_needs_managed_profile", "server-app.login.needsManaged");
    const harness = acpHarness(p.agent);
    if (harness && !harness.login)
      fail(400, "login_unsupported", "server-app.login.unsupported", { name: harness.name, hint: harnessText(harness, "loginHint", requestT(req)) });
    if (
      store.one(
        "SELECT j.id FROM jobs j JOIN sessions s ON j.session_id=s.id WHERE json_extract(s.data,'$.profileId')=? AND j.status IN ('queued','running')",
        p.id,
      )
    )
      fail(409, "profile_busy", "server-app.login.profileBusy");
    const existing = store.one(
      "SELECT * FROM logins WHERE profile_id=? AND status IN ('queued','running','waiting')",
      p.id,
    );
    if (existing) return view(existing);
    if (
      store.one(
        "SELECT COUNT(*) AS n FROM logins WHERE owner_id=? AND status IN ('queued','running','waiting')",
        u.id,
      ).n >= 5
    )
      fail(429, "login_limit", "server-app.login.tooMany");
    const r = {
      id: id(),
      owner_id: u.id,
      node_id: p.nodeId,
      profile_id: p.id,
      status: "queued",
      data: "{}",
      expires: Date.now() + 15 * 60_000,
    };
    store.run(
      "INSERT INTO logins(id,owner_id,node_id,profile_id,status,data,expires) VALUES(?,?,?,?,?,?,?)",
      r.id,
      r.owner_id,
      r.node_id,
      r.profile_id,
      r.status,
      r.data,
      r.expires,
    );
    store.audit(u.id, "identity.login", p.id);
    return view(r);
  });
  serve(app, P.logins, async (req: any) => {
    const u = user(req);
    reap();
    return store
      .all(
        "SELECT * FROM logins WHERE owner_id=? ORDER BY rowid DESC LIMIT 30",
        u.id,
      )
      .map(view);
  });
  serve(app, P.login, async (req: any) => view(own(req)));
  serve(app, P.loginInput, async (req: any) => {
    const r = own(req),
      b = P.loginInput.body.parse(req.body);
    if (r.status !== "waiting" || !JSON.parse(r.data).needsInput)
      fail(409, "login_no_input", "server-app.login.noInput");
    store.run(
      "UPDATE logins SET input=? WHERE id=?",
      store.encrypt(b.code),
      r.id,
    );
    return { ok: true };
  });
  serve(app, P.loginCancel, async (req: any) => {
    const r = own(req);
    store.run(
      "UPDATE logins SET cancel=1,status='cancelled',data='{}',input='' WHERE id=?",
      r.id,
    );
    return { ok: true };
  });
  runner.post("/logins/claim", async (req: any) => {
    const n = claimingNode(req);
    reap();
    return store.atomic(() => {
      const r = store.one(
        "SELECT * FROM logins WHERE node_id=? AND status='queued' AND cancel=0 ORDER BY rowid LIMIT 1",
        n.id,
      );
      if (!r) return { login: null };
      const lease = randomBytes(24).toString("base64url");
      store.run(
        "UPDATE logins SET status='running',lease=?,lease_until=? WHERE id=?",
        lease,
        Date.now() + 30_000,
        r.id,
      );
      return {
        login: {
          id: r.id,
          lease,
          expiresAt: r.expires,
          profile: JSON.parse(
            store.one("SELECT data FROM profiles WHERE id=?", r.profile_id)
              .data,
          ),
        },
      };
    });
  });
  runner.post("/logins/:id/pulse", async (req: any) => {
    const r = leased(req);
    store.run(
      "UPDATE logins SET lease_until=?,input='' WHERE id=?",
      Date.now() + 30_000,
      r.id,
    );
    return {
      cancel: !!r.cancel,
      code: r.input ? store.decrypt(r.input) : null,
    };
  });
  runner.post("/logins/:id/update", async (req: any) => {
    const r = leased(req),
      b = z
        .object({
          status: z.enum(["running", "waiting", "complete", "error"]),
          message: z.string().max(4000).optional(),
          url: z.string().max(6000).optional(),
          userCode: z.string().max(100).optional(),
          needsInput: z.boolean().optional(),
        })
        .parse(req.body);
    if (b.url) {
      let host = "";
      try {
        const u = new URL(b.url);
        if (u.protocol === "https:") host = u.hostname;
      } catch {}
      if (
        ![
          "auth.openai.com",
          "claude.ai",
          "claude.com",
          "console.anthropic.com",
          "platform.claude.com",
          // P4-10: the ACP harnesses' login pages (acp-harnesses.ts).
          ...ACP_LOGIN_HOSTS,
        ].includes(host)
      )
        fail(400, "login_url_untrusted", "server-app.login.untrustedUrl");
    }
    const data = ["complete", "error"].includes(b.status)
      ? { message: b.message }
      : b;
    store.run(
      "UPDATE logins SET status=?,data=?,input=CASE WHEN ? THEN '' ELSE input END WHERE id=?",
      b.status,
      JSON.stringify(data),
      ["complete", "error"].includes(b.status) ? 1 : 0,
      r.id,
    );
    if (b.status === "complete") {
      const row = store.one(
        "SELECT data FROM profiles WHERE id=?",
        r.profile_id,
      );
      if (row) {
        const p = JSON.parse(row.data);
        p.lastAuthenticatedAt = Date.now();
        store.run(
          "UPDATE profiles SET data=? WHERE id=?",
          JSON.stringify(p),
          r.profile_id,
        );
      }
      store.audit(r.owner_id, "identity.login.complete", r.profile_id);
    }
    return { ok: true };
  });
}
