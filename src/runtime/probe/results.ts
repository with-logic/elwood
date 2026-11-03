/**
 * The results a probe settles with when its command did not simply exit: a spawn error, a
 * bound, an overflow, a login shell that never started the command, or the e2e home guard
 * (PRD §9.2, C-PERF-03, C-PERF-05, C-E2E-24).
 */

import { homeGuardExitCode, homeGuardStoppedReason } from "../home-guard/index.ts";
import type { CommandResult } from "../seams.ts";
import { maxProbeStreamOutputBytes } from "./capped-buffer.ts";

export function mapError(error: NodeJS.ErrnoException): {
  readonly code?: string | undefined;
  readonly message: string;
} {
  return { code: error.code, message: error.message };
}

export function commandTimedOut(ms: number, stdout: string, stderr: string): CommandResult {
  const message = `probe timed out after ${ms} ms`;
  return { status: null, stdout, stderr, error: { code: "ETIMEDOUT", message } };
}

export function launchTimedOut(ms: number, stdout: string, stderr: string): CommandResult {
  const message = `login shell did not start the probe command within ${ms} ms`;
  const error = { code: "ETIMEDOUT", message, phase: "login_shell" } as const;
  return { status: null, stdout, stderr, error };
}

export function shellExited(status: number | null, stdout: string, stderr: string): CommandResult {
  const message = `login shell exited with status ${status} before starting the probe command`;
  const error = { message, phase: "login_shell", shellStatus: status } as const;
  return { status: null, stdout, stderr, error };
}

/** A probe the e2e home guard stopped: the login shell's failure, with only the fixed reason. */
export function guardStopped(stdout: string, stderr: string): CommandResult {
  const error = {
    message: homeGuardStoppedReason,
    phase: "login_shell",
    shellStatus: homeGuardExitCode,
  } as const;
  return { status: null, stdout, stderr, error };
}

export function overflow(stdout: string, stderr: string): CommandResult {
  const message = `a probe output stream exceeded ${maxProbeStreamOutputBytes} bytes`;
  return { status: null, stdout, stderr, error: { code: "E2BIG", message } };
}
