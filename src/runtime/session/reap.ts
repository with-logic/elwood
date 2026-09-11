/**
 * Owns the session's one-shot survivor reaper and its two NON-interchangeable
 * failure policies (PRD §5.3, C-LIFE-10):
 *   - `bestEffort()` for the native unsolicited-exit callback: a reap failure must
 *     never throw out of that callback, so it is contained and RETURNED as a
 *     live `reap_failed` warning (emitted once when observed), never silently dropped.
 *   - `orThrow()` for an explicit `stop()`/`kill()` on an already-terminal session:
 *     it must NOT swallow — it throws a typed `termination_failed` so the caller
 *     rejects with an ElwoodError (C-ERR-01) and teardown can retry the
 *     still-unlatched reap.
 * `reaper` exposes the underlying one-shot for `teardown`'s retry step and the
 * `terminatePty` termination path, which own their own failure handling.
 */

import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import { reapFailureWarning } from "../../core/activity/index.ts";
import { causeDetails, elwoodError } from "../../core/errors.ts";
import type { ElwoodWarningEvent } from "../../core/types.ts";
import { SessionReaper } from "../shutdown/reap-tree.ts";

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

  /** Reap on explicit shutdown; wrap any failure as a typed `termination_failed`. */
  orThrow(): void {
    try {
      this.reaper.reap();
    } catch (error) {
      throw elwoodError("termination_failed", "Could not reap the PTY process group.", {
        ...causeDetails(error),
        processGroupId: this.leaderPid,
      });
    }
  }
}
