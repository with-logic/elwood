/**
 * The results a probe settles with when its command did not simply exit: a spawn error, a
 * bound, an overflow, a login shell with no observed command start line, or the e2e home guard
 * (PRD §9.2, C-PERF-03, C-PERF-05, C-E2E-24; native spawn diagnostics, C-ERR-08).
 */

import { toError } from "../../core/errors.ts";
import { homeGuardExitCode, homeGuardStoppedReason } from "../home-guard/index.ts";
import type { CommandResult } from "../seams.ts";
import { maxProbeStreamOutputBytes } from "./capped-buffer.ts";

export function mapError(error: NodeJS.ErrnoException): NonNullable<CommandResult["error"]> {
  return { code: error.code, syscall: error.syscall, path: error.path, message: error.message };
}

export type AbortResult = Omit<CommandResult, "status"> & {
  readonly status: null;
  readonly error: NonNullable<CommandResult["error"]>;
};

export function commandTimedOut(ms: number, stdout: string, stderr: string): AbortResult {
  const message = `probe timed out after ${ms} ms`;
  return { status: null, stdout, stderr, error: { code: "ETIMEDOUT", message } };
}

export function launchTimedOut(ms: number, stdout: string, stderr: string): AbortResult {
  const message = `probe command start was not observed within ${ms} ms`;
  const error = { code: "ETIMEDOUT", message, phase: "command_start_unobserved" } as const;
  return { status: null, stdout, stderr, error };
}

export function shellExited(status: number | null, stdout: string, stderr: string): CommandResult {
  const message = `login shell exited with status ${status} without an observed probe start line`;
  const error = { message, phase: "command_start_unobserved", shellStatus: status } as const;
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

export function overflow(stdout: string, stderr: string): AbortResult {
  const message = `a probe output stream exceeded ${maxProbeStreamOutputBytes} bytes`;
  return { status: null, stdout, stderr, error: { code: "E2BIG", message } };
}

/** Output setup failed before any shell or CLI was started (C-ERR-08). */
export function outputUnavailable(error: unknown): AbortResult {
  return {
    status: null,
    stdout: "",
    stderr: "",
    error: { ...mapError(toError(error)), origin: "probe_setup" },
  };
}
