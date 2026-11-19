/**
 * P1-03: the running Daisy of this account, for the manual smoke scripts
 * (they used to log in as `admin` with the password in .data/ACCESS.md).
 * Reads the runtime file (where it listens) and the command line's
 * credential, then — as the owner at the keyboard would with `daisy open`
 * — trades a one-time code for a web session, so the scripts can also
 * answer the AI's approvals (which the command-line channel cannot).
 */
import { readFileSync } from "node:fs";
import { DaisyClient } from "../packages/client/src/index.ts";
import { dataDir, runtimeFile } from "../packages/daisy/src/platform/paths.ts";

export async function ownerClient(): Promise<DaisyClient> {
  const rt = JSON.parse(readFileSync(runtimeFile(dataDir()), "utf8"));
  const url: string = rt.local?.url;
  if (!url) throw Error("Daisy is not running (the runtime file has no local address): run npm start first");
  const cli = new DaisyClient(url, readFileSync(rt.cliCredential, "utf8").trim());
  const { code } = await cli.request<{ code: string }>("/web/open-code", "POST", {});
  const c = new DaisyClient(url, "");
  await c.webSession(code);
  return c;
}
