#!/usr/bin/env node
/**
 * P5-01 (ADR-143): the `daisy-relay` command's entry (bundled into
 * dist/daisy-relay.mjs).
 */
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2));
