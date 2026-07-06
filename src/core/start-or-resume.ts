/**
 * Shared try-resume-else-start policy for adapter entry points.
 * Implements PRD §5.2, §5.6, and C-API-26.
 */

import { ElwoodError, type ElwoodErrorName } from "./errors.ts";

export type StartOrResumeResult<S> = {
  readonly session: S;
  readonly resumed: boolean;
};

/** Error names that mean "no resumable session exists" rather than failure. */
const fallbackCodes: ReadonlySet<ElwoodErrorName> = new Set([
  "state_not_found",
  "resume_unavailable",
  "adapter_mismatch",
]);

export async function startOrResume<S>(
  elwoodSessionId: string | undefined,
  resume: (elwoodSessionId: string) => Promise<S>,
  start: () => Promise<S>,
): Promise<StartOrResumeResult<S>> {
  if (elwoodSessionId !== undefined) {
    try {
      return { session: await resume(elwoodSessionId), resumed: true };
    } catch (error) {
      if (!(error instanceof ElwoodError && fallbackCodes.has(error.code))) throw error;
    }
  }
  return { session: await start(), resumed: false };
}
