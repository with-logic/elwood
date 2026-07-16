/**
 * Mid-session Claude login-expiry detection (PRD §5.3, §5.7, C-CLAUDE-18).
 * When a lapsed/revoked-login banner appears on a session that has ALREADY
 * reached readiness — login expiring during use — Elwood surfaces a bounded,
 * content-free `login_expired` warning and leaves the session alive so the caller
 * can recover in place via `session.login()`, tear down, or re-auth out of band.
 * The startup-time form of the same banner is handled fatally in runtime/startup.ts.
 */

import type { ElwoodWarningEvent } from "../core/types.ts";
import { isLoginExpiredText } from "../runtime/startup.ts";

export const LOGIN_RECOVERY_COMMAND = "/login";

/**
 * Edge-detects the login-expired banner so the warning fires ONCE per occurrence:
 * it emits on the raised edge (banner appears while absent) and re-arms only after
 * the banner clears, so a persistent banner across many frames warns a single time
 * while a genuine re-expiry after a recovery warns again.
 */
export class LoginExpiredWatcher {
  private present = false;

  /** Returns true exactly on the frame where the banner first appears. */
  observe(screenText: string): boolean {
    const visible = isLoginExpiredText(screenText);
    const raised = visible && !this.present;
    this.present = visible;
    return raised;
  }
}

export function loginExpiredWarning(elwoodSessionId: string): ElwoodWarningEvent {
  return {
    elwoodSessionId,
    agent: "claude",
    source: "terminal",
    code: "login_expired",
    severity: "warning",
    message: `Claude's login expired mid-session; it cannot act until re-authenticated. Run ${LOGIN_RECOVERY_COMMAND} (or session.login()) to recover.`,
    recoveryCommand: LOGIN_RECOVERY_COMMAND,
    raw: `login_expired recovery=${LOGIN_RECOVERY_COMMAND}`,
  };
}
