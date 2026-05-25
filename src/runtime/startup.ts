/**
 * Startup readiness checks for newly spawned agent PTYs.
 * Implements PRD §9.1 and §10.
 */

import { elwoodError } from "../core/errors.ts";
import type { PtyExit } from "../pty/types.ts";

export type StartupAdapter = "claude" | "codex";
type StartupValue<T> = T | (() => T);

export async function assertStartupUsable(input: {
  readonly adapter: StartupAdapter;
  readonly exit: StartupValue<PtyExit | undefined>;
  readonly output: StartupValue<string>;
  readonly waitMs?: number;
}): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, input.waitMs ?? 25));
  const exit = readStartupValue(input.exit);
  if (exit) {
    throw elwoodError(`${input.adapter}_start_failed`, `${input.adapter} exited during startup.`, {
      exitCode: exit.exitCode,
      signal: exit.signal,
    });
  }
  if (isAuthFailure(readStartupValue(input.output))) {
    throw elwoodError(
      `${input.adapter}_not_authenticated`,
      `${input.adapter} is not authenticated.`,
    );
  }
}

function isAuthFailure(output: string): boolean {
  return /not authenticated|not logged in|login required|authentication failed/i.test(output);
}

function readStartupValue<T>(value: StartupValue<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
}
