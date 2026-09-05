#!/usr/bin/env node

/**
 * Binds the Elwood CLI command boundary to the real Node process.
 * Implements PRD §12A and C-CLI-01/C-CLI-02.
 */

import { fileURLToPath } from "node:url";
import { main } from "./main.ts";

export type CliProcess = {
  readonly argv: readonly string[];
  readonly stdout: { readonly write: (value: string) => unknown };
  readonly stderr: { readonly write: (value: string) => unknown };
  exitCode: string | number | null | undefined;
};

/** Run the CLI against process-like streams and retain its exit status. */
export function runCli(proc: CliProcess): number {
  const exitCode = main(proc.argv.slice(2), proc);
  proc.exitCode = exitCode;
  return exitCode;
}

/** Run only when this module is the process entrypoint. */
export function bootstrapCliIfMain(
  meta: { readonly url: string },
  proc: CliProcess,
): number | null {
  if (proc.argv[1] === undefined || fileURLToPath(meta.url) !== proc.argv[1]) return null;
  return runCli(proc);
}

bootstrapCliIfMain(import.meta, process);
