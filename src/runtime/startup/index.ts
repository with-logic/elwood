/**
 * Startup readiness checks for newly spawned agent PTYs.
 * Implements PRD §9.1 and §10, and names the e2e home guard of §12 (C-E2E-24).
 */

import { isClaudeReauthRequiredText } from "../../claude/login/expiry-screen.ts";
import { elwoodError } from "../../core/errors.ts";
import type { PtyExit } from "../../pty/types.ts";
import { homeGuardStopped, homeGuardStoppedReason } from "../home-guard/index.ts";

export type StartupAdapter = "claude" | "codex";
type StartupValue<T> = T | (() => T);
let startupWaitMs = 500;

export function setStartupWaitMsForTests(value: number): void {
  startupWaitMs = value;
}

export function resetStartupWaitMsForTests(): void {
  startupWaitMs = 500;
}

export async function assertStartupUsable(input: {
  readonly adapter: StartupAdapter;
  readonly exit: StartupValue<PtyExit | undefined>;
  readonly output: StartupValue<string>;
  readonly waitMs?: number;
}): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, input.waitMs ?? startupWaitMs));
  const exit = readStartupValue(input.exit);
  if (exit) {
    // The guard's own line is in the output, among the user's startup output: name the guard
    // instead of forwarding that output.
    const stopped = homeGuardStopped(exit.exitCode, readStartupValue(input.output));
    const guard = stopped ? `: ${homeGuardStoppedReason}` : "";
    throw elwoodError(
      `${input.adapter}_start_failed`,
      `${input.adapter} exited during startup${guard}.`,
      { exitCode: exit.exitCode, signal: exit.signal },
    );
  }
  if (isAuthFailure(input.adapter, readStartupValue(input.output))) {
    throw elwoodError(
      `${input.adapter}_not_authenticated`,
      `${input.adapter} is not authenticated.`,
    );
  }
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
