/** Preserve force-sweep and graceful-survivor diagnostics together (PRD §9.4, C-LIFE-10). */
import { errnoCode, isErrnoToken, toError } from "../../core/errors.ts";
import { MAX_REPORTED_GROUPS, type SweepFailure } from "./detached-sweep/failures.ts";

/** Both internal sweep phases produce the same bounded diagnostic group field. */
export function mergeSweepErrors(
  first: SweepFailure | undefined,
  later: SweepFailure,
): SweepFailure;
export function mergeSweepErrors(first: unknown, later: unknown): Error;
export function mergeSweepErrors(first: unknown, later: unknown): Error {
  const second = toError(later);
  if (first === undefined || first === later) return second;
  const primary = toError(first);
  const groups = (error: Error) => (error as Partial<SweepFailure>).processGroupIds ?? [];
  const code = errnoCode(primary) ?? errnoCode(second);
  return Object.assign(
    new AggregateError([primary, second], `${primary.message}; ${second.message}`),
    {
      processGroupIds: [...new Set([...groups(primary), ...groups(second)])].slice(
        0,
        MAX_REPORTED_GROUPS,
      ),
      ...(isErrnoToken(code) ? { code } : {}),
    },
  );
}

/** Keep a lone signal error unchanged, or preserve every combined cause and first errno. */
export function throwSignalFailures(failures: readonly unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw aggregateSignalFailures(failures);
}

/** Preserve combined signal causes and messages with the first failure's errno. */
export function aggregateSignalFailures(failures: readonly unknown[]): AggregateError {
  const code = errnoCode(failures[0]);
  return Object.assign(
    new AggregateError(failures, failures.map((error) => toError(error).message).join("; ")),
    code === undefined ? {} : { code },
  );
}
