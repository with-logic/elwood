/**
 * Failure accounting for the detached-descendant sweep (PRD §5.3 and §9.4, C-LIFE-10):
 * fixed reason phrases, an errno-shaped token when one applies, and a bounded list of
 * the groups involved, so a failure never carries raw process or `ps` output.
 */

import { errnoCode } from "../../../core/errors.ts";

/** A sweep that could not confirm every group reaped, naming (some of) those groups. */
export type SweepFailure = Error & { readonly groups: readonly number[] };

/** At most this many group ids travel with a failure: enough to inspect, still bounded. */
export const MAX_REPORTED_GROUPS = 16;

export type FailureReason =
  | "process table unreadable"
  | "descendant groups still appearing at the deadline"
  | "the leader exited before every descendant group was stopped"
  | "could not stop the leader's group"
  | "could not stop a live descendant group"
  | "could not kill a stopped descendant group";

// An errno-shaped token (`EPERM`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`): fixed by the
// platform, never process or user content, so it can travel in a public message.
const ERRNO_TOKEN = /^E[A-Z0-9_]{1,40}$/;

/** Collects one sweep's failures: each reason once, the first errno token, the groups. */
export class SweepFailures {
  private readonly reasons = new Set<string>();
  private readonly groups = new Set<number>();
  private code: string | undefined;

  record(reason: FailureReason, error: unknown, groups: readonly number[]): void {
    const code = errnoCode(error);
    const token = code !== undefined && ERRNO_TOKEN.test(code) ? code : undefined;
    this.reasons.add(token === undefined ? reason : `${reason} (${token})`);
    this.code ??= token;
    for (const group of groups) this.groups.add(group);
  }

  /** The combined failure, or `undefined` when nothing was recorded. */
  result(): SweepFailure | undefined {
    if (this.reasons.size === 0) return undefined;
    const message = `Could not reap detached descendants: ${[...this.reasons].join("; ")}`;
    const groups = [...this.groups].slice(0, MAX_REPORTED_GROUPS);
    const code = this.code === undefined ? {} : { code: this.code };
    return Object.assign(new Error(message), { groups, ...code });
  }
}
