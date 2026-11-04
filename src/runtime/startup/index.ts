/**
 * Startup readiness checks for newly spawned agent PTYs.
 * Implements PRD §9.1 and §10, and names the e2e home guard of §12 (C-E2E-24).
 */

import { isClaudeReauthRequiredText } from "../../claude/login/expiry-screen.ts";
import { delay } from "../../core/delay.ts";
import {
  type DirectoryGuardObservation,
  directoryGuardExitCode,
  directoryGuardStoppedReason,
} from "../../core/directory-guard.ts";
import { elwoodError } from "../../core/errors.ts";
import type { PtyExit } from "../../pty/types.ts";
import { homeGuardExitCode, homeGuardStoppedReason } from "../home-guard/index.ts";

export type StartupAdapter = "claude" | "codex";
type StartupValue<T> = T | (() => T);
let startupWaitMs = 500;
/**
 * Once a checked launch exits with a guard status, wait at most this long for its marker:
 * a PTY's last output can arrive after its exit (§9.4).
 */
const stopMarkerGraceMs = 1_000;
/** How often that wait looks for the line: often enough to add little to a stop's report. */
const stopMarkerPollMs = 10;

export function setStartupWaitMsForTests(value: number): void {
  startupWaitMs = value;
}

export function resetStartupWaitMsForTests(): void {
  startupWaitMs = 500;
}

/**
 * Fails a session's start when its launch is refused, its CLI exits, or login is required. It waits
 * `waitMs` (500 ms by default) first, then reads the exit and the output once. A checked
 * directory/home guard status may wait up to `stopMarkerGraceMs` more for its private
 * marker; other statuses add no wait (C-API-61, C-E2E-24).
 */
export async function assertStartupUsable(input: {
  readonly adapter: StartupAdapter;
  readonly exit: StartupValue<PtyExit | undefined>;
  readonly output: StartupValue<string>;
  /**
   * Whether the output carried the e2e home guard's stop marker, past any cap on `output`;
   * `undefined` for a launch the guard does not check.
   */
  readonly sawStopMarker?: (() => boolean) | undefined;
  readonly directoryGuard?: DirectoryGuardObservation | undefined;
  readonly waitMs?: number;
}): Promise<void> {
  await delay(input.waitMs ?? startupWaitMs);
  const exit = readStartupValue(input.exit);
  if (exit) {
    // The guard's own line is in the output, among the user's startup output: name the guard
    // instead of forwarding that output.
    const stopped = await stoppedByGuard(exit.exitCode, input.sawStopMarker);
    const directory = input.directoryGuard;
    const directoryStopped =
      directory !== undefined &&
      (await stoppedByGuard(exit.exitCode, directory.sawMarker, directoryGuardExitCode));
    const guard = stopped ? `: ${homeGuardStoppedReason}` : "";
    const message = directoryStopped
      ? `${input.adapter} did not start: ${directoryGuardStoppedReason}.`
      : `${input.adapter} exited during startup${guard}.`;
    throw elwoodError(`${input.adapter}_start_failed`, message, {
      exitCode: exit.exitCode,
      signal: exit.signal,
      ...(directoryStopped ? { cwd: directory.cwd } : {}),
    });
  }
  if (isAuthFailure(input.adapter, readStartupValue(input.output))) {
    throw elwoodError(
      `${input.adapter}_not_authenticated`,
      `${input.adapter} is not authenticated.`,
    );
  }
}

/**
 * Whether a checked guard stopped the shell. Its status and private marker must both
 * match; only that status waits for late output, within the existing startup grace.
 */
async function stoppedByGuard(
  exitCode: number,
  sawMarker: (() => boolean) | undefined,
  guardExitCode: typeof homeGuardExitCode | typeof directoryGuardExitCode = homeGuardExitCode,
): Promise<boolean> {
  if (sawMarker === undefined) return false;
  if (exitCode === guardExitCode) {
    const deadline = performance.now() + stopMarkerGraceMs;
    while (!sawMarker() && performance.now() < deadline) await delay(stopMarkerPollMs);
  }
  return exitCode === guardExitCode && sawMarker();
}

function isAuthFailure(adapter: StartupAdapter, output: string): boolean {
  // Claude's re-authentication banner ("Login expired" then "Please run /login")
  // spans multiple lines, so it is matched against the WHOLE output, not per line,
  // and only for Claude (C-CLAUDE-17). Other forms are single-line, both adapters.
  if (adapter === "claude" && isClaudeReauthRequiredText(output)) return true;
  return output.split(/\r?\n/).some((line) => isAuthFailureLine(adapter, line));
}

function isAuthFailureLine(adapter: StartupAdapter, line: string): boolean {
  if (/not authenticated|login required|authentication failed/i.test(line)) return true;
  if (!/not logged in/i.test(line)) return false;
  if (adapter === "codex" && /\bmcp server\b/i.test(line)) return false;
  return true;
}

function readStartupValue<T>(value: StartupValue<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
}
