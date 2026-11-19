#!/usr/bin/env node
/**
 * P4-09 (ADR-128): the `daisy-mcp` command's entry (bundled into
 * dist/daisy-mcp.mjs). Production settings only: nothing here — no flag, no
 * environment variable — relaxes the outbound rules (loopback stays refused).
 */
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2));
