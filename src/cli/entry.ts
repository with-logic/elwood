#!/usr/bin/env node

/**
 * Binds the side-effect-free Elwood command to Node streams, environment, and SIGINT.
 * Implements PRD §12A and C-CLI-01/C-CLI-02/C-CLI-07/C-CLI-12/C-CLI-23.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createProcessHeadTarget } from "./head/process.ts";
import { type CliMainContext, type CliMainDependencies, main } from "./main.ts";
import type { CliWritable } from "./stream.ts";

export type CliProcess = {
  readonly argv: readonly string[];
  readonly stdout: CliWritable & { readonly isTTY?: boolean };
  readonly stderr: CliWritable;
  readonly stdin: AsyncIterable<string | Uint8Array> & { readonly isTTY?: boolean };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: () => string;
  readonly on: (event: "SIGINT", handler: () => void) => unknown;
  readonly off: (event: "SIGINT", handler: () => void) => unknown;
  exitCode: string | number | null | undefined;
};

/** Run the CLI against a process-like boundary and retain its settled exit status. */
export async function runCli(
  proc: CliProcess,
  dependencies?: CliMainDependencies,
  userHome = homedir(),
): Promise<number> {
  const exitCode = await main(proc.argv.slice(2), processContext(proc, userHome), dependencies);
  proc.exitCode = exitCode;
  return exitCode;
}

/** Run only when this module is the actual process entrypoint. */
export function bootstrapCliIfMain(
  meta: { readonly url: string },
  proc: CliProcess,
  dependencies?: CliMainDependencies,
  userHome?: string,
): Promise<number> | null {
  if (proc.argv[1] === undefined || !isSameFile(fileURLToPath(meta.url), proc.argv[1])) return null;
  return runCli(proc, dependencies, userHome);
}

function isSameFile(modulePath: string, entryPath: string): boolean {
  if (modulePath === entryPath) return true;
  try {
    return realpathSync(modulePath) === realpathSync(entryPath);
  } catch {
    return false;
  }
}

function processContext(proc: CliProcess, userHome: string): CliMainContext {
  const head = createProcessHeadTarget(proc.stdin, proc.stderr);
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    stdin: {
      source: proc.stdin,
      ...(proc.stdin.isTTY === undefined ? {} : { isTTY: proc.stdin.isTTY }),
    },
    ...(proc.stdout.isTTY === undefined ? {} : { stdoutIsTTY: proc.stdout.isTTY }),
    env: proc.env,
    invocationCwd: proc.cwd(),
    homeDir: userHome,
    signals: {
      onSigint: (handler) => {
        proc.on("SIGINT", handler);
        return () => {
          proc.off("SIGINT", handler);
        };
      },
    },
    ...(head === undefined ? {} : { head }),
  };
}

await bootstrapCliIfMain(import.meta, process);
