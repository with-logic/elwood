/**
 * Owns the session's one-shot survivor reaper and its two NON-interchangeable
 * failure policies (PRD §5.3, C-LIFE-10):
 *   - `bestEffort()` for the native unsolicited-exit callback: a reap failure must
 *     never throw out of that callback, so it is contained and RETURNED as a
 *     live `reap_failed` warning (emitted once when observed), never silently dropped.
 *   - `orThrow()` for an explicit `stop()`/`kill()` on an already-terminal session
 *     and for `teardown`'s retry step: it must NOT swallow — it throws a typed
 *     `termination_failed` (with errno and the leader's process-group id).
 *     Original syscall reaps stay retryable until authority is retired; retained
 *     history instead awaits confirmation without renewing numeric signal authority.
 * `reaper` exposes the underlying one-shot for the `terminatePty` termination path,
 * which owns its own failure handling.
 */

import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import { reapFailureWarning } from "../../core/activity/index.ts";
import { causeDetails, elwoodError, toError } from "../../core/errors.ts";
import type { ElwoodWarningEvent } from "../../core/types.ts";
import { SessionReaper } from "../shutdown/reap-tree.ts";
import { unconfirmedGroupsDetail } from "../shutdown/terminate.ts";

export class SessionReapPolicy {
  readonly reaper: SessionReaper;
  private readonly agent: ElwoodAgentKind;
  private readonly elwoodSessionId: string;
  private readonly leaderPid: number;

  constructor(agent: ElwoodAgentKind, elwoodSessionId: string, leaderPid: number) {
    this.agent = agent;
    this.elwoodSessionId = elwoodSessionId;
    this.leaderPid = leaderPid;
    this.reaper = new SessionReaper(leaderPid);
  }

  /** Contain a native-exit reap failure as a live warning to emit; never throw. */
  bestEffort(): ElwoodWarningEvent | undefined {
    try {
      this.reaper.reap();
      return undefined;
    } catch (error) {
      return reapFailureWarning(this.agent, this.elwoodSessionId, this.leaderPid, error);
    }
  }

  /**
   * Retry an eligible original reap or confirm retained cleanup evidence; preserve
   * unresolved ownership and wrap failures as typed `termination_failed`.
   */
  async orThrow(): Promise<void> {
    try {
      await this.reaper.reapOrConfirmAndThrowIfUnresolved();
    } catch (error) {
      throw elwoodError(
        "termination_failed",
        "Could not confirm the PTY process tree was reaped.",
        {
          ...causeDetails(error),
          ...unconfirmedGroupsDetail(toError(error)),
          processGroupId: this.leaderPid,
        },
      );
    }
  }
}
