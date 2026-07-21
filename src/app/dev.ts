/**
 * Manual local test app entrypoint.
 * Implements PRD §11.
 *
 * The bootstrap is behind `runDevApp`/`bootstrapDevAppIfMain` so importing this
 * module has no side effects (no PTY, no stdin read) and the entrypoint is fully
 * testable; the process only launches a session when this file is the entry.
 */

import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { defaultTestAppRuntime, runTestApp, type TestAppRuntime } from "./test-app.ts";

export type DevAppProcess = {
  readonly argv: readonly string[];
  readonly stdin: AsyncIterable<string | Uint8Array>;
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
};

export type DevAppDeps = {
  readonly proc: DevAppProcess;
  readonly runtime: TestAppRuntime;
};

/** Run the manual test app against the given process streams; resolves to the id. */
export function runDevApp(deps: DevAppDeps): Promise<string> {
  return runTestApp(
    deps.proc.argv.slice(2),
    { stdin: deps.proc.stdin, stdout: deps.proc.stdout, stderr: deps.proc.stderr },
    deps.runtime,
  );
}

/** Launch the test app when this module is the process entry; else return null. */
export function bootstrapDevAppIfMain(
  meta: { readonly url: string },
  deps: DevAppDeps,
): Promise<string> | null {
  if (argv[1] === undefined || fileURLToPath(meta.url) !== argv[1]) return null;
  return runDevApp(deps);
}

await bootstrapDevAppIfMain(import.meta, { proc: process, runtime: defaultTestAppRuntime });
