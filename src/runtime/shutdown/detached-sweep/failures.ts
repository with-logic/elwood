/**
 * Failure accounting for the detached-descendant sweep (PRD §5.3 and §9.4, C-LIFE-10):
 * fixed reason phrases, an errno-shaped token when one applies, and a bounded list of
 * the process-group ids involved, so a failure never carries raw process or `ps` output.
 */

import { errnoCode, isErrnoToken } from "../../../core/errors.ts";

/** A sweep that could not confirm every group reaped, naming (some of) those groups. */
export type SweepFailure = Error & {
  readonly processGroupIds: readonly number[];
  /** The first errno token among the failures, when one applies. */
  readonly code?: string;
};

/** At most this many process-group ids travel with a failure: enough to inspect, bounded. */
export const MAX_REPORTED_GROUPS = 16;

export type FailureReason =
  | "process table unreadable"
  | "process groups not confirmed stopped by the deadline"
  | "the leader exited before every group was confirmed stopped"
  | "could not stop the leader's group"
  | "could not stop a live descendant group"
  | "could not kill a signaled descendant group"
  | "could not resume a group spared for Codex's shared daemon";

/** Collects one sweep's failures: each reason once, the first errno token, the group ids. */
export class SweepFailures {
  private readonly reasons = new Set<string>();
  private readonly processGroupIds = new Set<number>();
  private code: string | undefined;

  record(reason: FailureReason, error: unknown, processGroupIds: readonly number[]): void {
    const code = errnoCode(error);
    const token = isErrnoToken(code) ? code : undefined;
    this.reasons.add(token === undefined ? reason : `${reason} (${token})`);
    this.code ??= token;
    for (const id of processGroupIds) this.processGroupIds.add(id);
  }

  /** The combined failure, or `undefined` when nothing was recorded. */
  result(): SweepFailure | undefined {
    if (this.reasons.size === 0) return undefined;
    const message = `Could not reap detached descendants: ${[...this.reasons].join("; ")}`;
    const processGroupIds = [...this.processGroupIds].slice(0, MAX_REPORTED_GROUPS);
    const code = this.code === undefined ? {} : { code: this.code };
    return Object.assign(new Error(message), { processGroupIds, ...code });
  }
}
