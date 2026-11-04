/** Shared update outcome types and cache-admission policy (PRD §9.2, C-LIFE-09/11). */
import { ElwoodError } from "../../core/errors.ts";
import { isUpdateSkipReason } from "../../core/warnings/update-skips.ts";

/** The outcome of a best-effort autoupdate: failures are values, not rejected promises. */
export type AutoupdateOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown; readonly notStarted?: true };

/** Verification runs only after lease ownership, before the updater may be invoked. */
export type UpdateSteps = {
  /** Any resolved value passes; rejection means verification failed before updater invocation. */
  readonly verify: () => Promise<unknown>;
  readonly update: () => Promise<void>;
};

/** Sharing with current waiters is independent of retaining the outcome for later calls. */
export type Attempt = {
  readonly retrySharers: boolean;
  readonly outcome: AutoupdateOutcome;
};

/** Only explicit coordinator skip reasons prove a rejection happened before invocation. */
export function unstartedSkip(error: unknown): boolean {
  return error instanceof ElwoodError && isUpdateSkipReason(error.details["updateReason"]);
}

/** Local no-attempts leave caches valid; a skipped peer update may have changed the binary. */
export function shouldPreservePreflightCaches(outcome: AutoupdateOutcome): boolean {
  return !outcome.ok && outcome.notStarted === true && !unstartedSkip(outcome.error);
}
