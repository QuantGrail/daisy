/**
 * P5-05 (ADR-141, plan 5.14): what this machine's system takes away from
 * what each harness declares — applied to the node's report
 * (`capabilities.agentFeatures`) so the control plane refuses it, the UI
 * hides it and the command line says so (C-3, P4-11), and reported as
 * `capabilities.platform` for the settings page and `daisy status`.
 *
 * - Windows without Daisy's helper: no official CLI window (`terminal`
 *   needs ConPTY through the helper).
 * - Windows, Codex: its read-only sandbox there depends on the Windows
 *   build and on an administrator's one-time setup (P0-03 item 4) — Daisy
 *   cannot tell which it gets, so 「问」 on Codex is declared `weak` there.
 *   Claude Code's read-only is a tool restriction, not a sandbox: `strong`
 *   everywhere.
 * - Not Linux: no kernel-enforced read-only layer (Bubblewrap) —
 *   `workspaceAccess.readOnly` is false (worker.ts), unchanged here.
 */
export interface PlatformFacts {
  platform: NodeJS.Platform;
  /** Windows: Daisy's helper (Job Objects, ConPTY, ACLs, start at login) is there. */
  helper: boolean;
  /** Windows: Git Bash (else PowerShell runs typed commands). */
  shell?: "git-bash" | "powershell";
}

export interface PlatformReport {
  version: 1;
  os: NodeJS.Platform;
  /** How a harness's whole process tree is ended. */
  processTree: "process-group" | "job-object" | "parent-only";
  /** The official CLI window's pseudo terminal. */
  terminal: "pty" | "conpty" | "none";
  /** Daisy's own kernel-enforced read-only layer. */
  enforcedReadOnly: boolean;
  /** What runs 「在终端执行」 and background commands. */
  shell: "bash" | "sh" | "git-bash" | "powershell";
  /** Owner-only files: mode bits or an ACL; null: cannot be set here. */
  ownerOnly: "mode" | "acl" | null;
}

export function platformReport(f: PlatformFacts, bwrap = false): PlatformReport {
  if (f.platform !== "win32")
    return {
      version: 1,
      os: f.platform,
      processTree: "process-group",
      terminal: "pty",
      enforcedReadOnly: f.platform === "linux" && bwrap,
      shell: "bash",
      ownerOnly: "mode",
    };
  return {
    version: 1,
    os: "win32",
    processTree: f.helper ? "job-object" : "parent-only",
    terminal: f.helper ? "conpty" : "none",
    enforcedReadOnly: false,
    shell: f.shell ?? "powershell",
    ownerOnly: f.helper ? "acl" : null,
  };
}

/** The agents' reports with what this system cannot do taken out (a copy). */
export function applyPlatform(agentFeatures: Record<string, any>, f: PlatformFacts): Record<string, any> {
  if (f.platform !== "win32") return agentFeatures;
  const out: Record<string, any> = {};
  for (const [agent, c] of Object.entries(agentFeatures)) {
    if (!c || typeof c !== "object") {
      out[agent] = c;
      continue;
    }
    let next = c;
    if (!f.helper && c.features?.terminal && c.features.terminal !== "none")
      next = { ...next, features: { ...next.features, terminal: "none" } };
    if (agent === "codex" && next.readOnly?.support === "native" && next.readOnly.opts?.strength === "strong")
      next = {
        ...next,
        readOnly: {
          ...next.readOnly,
          via: `${next.readOnly.via} (Windows: the sandbox's strength depends on the Windows build and setup)`,
          opts: { ...next.readOnly.opts, strength: "weak" },
        },
      };
    out[agent] = next;
  }
  return out;
}
