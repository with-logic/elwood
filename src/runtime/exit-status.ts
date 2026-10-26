/**
 * A process's exit as a shell reports it, shared by `elwood interactive` (PRD §12A.9,
 * C-CLI-25) and the probe runner (§9.2, C-PERF-05).
 */

import { constants } from "node:os";

/** A signal-terminated process maps to the shell convention 128 + signal number. */
export function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal === null ? undefined : constants.signals[signal];
  return number === undefined ? 1 : 128 + number;
}
