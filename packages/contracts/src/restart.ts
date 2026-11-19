/**
 * Restart of the Runner. The former per-node 「重启」 (a request stored per
 * node, handed to its Runner in the heartbeat) and the node table's view of
 * it went with P1-02: control plane and Runner are one process, restarted
 * as a whole (POST /api/update/restart, ADR-106). What stays is the
 * Runner's `capabilities.runner.restart`, version 2 since P1-02.
 */

/** capabilities.runner.restart (the Runner's state sync). */
export interface RestartCapability {
  version: number;
  /**
   * Exiting means being started again: systemd, launchd, the Windows
   * helper's `supervise` (or another supervisor, DAISY_RUNNER_SELF_RESTART=1),
   * or `respawn`.
   */
  supervised: boolean;
  /**
   * `respawn` (P5-06): a background process `daisy start` ran — no service
   * manager; on a restart it starts its successor itself.
   */
  manager: "systemd" | "launchd" | "supervise" | "respawn" | "none";
  /** systemd unit, launchd label or the Windows helper's name. */
  unit?: string;
  platform?: string;
  /** Why it is not supervised. */
  reason?: string;
}
