/**
 * Mid-session Claude login-expiry detection (PRD §5.3, §5.7, C-CLAUDE-18).
 * When a lapsed/revoked-login banner appears on a session that has ALREADY
 * reached readiness — login expiring during use — Elwood surfaces a bounded,
 * content-free `login_expired` warning and leaves the session alive so the caller
 * can recover in place via `session.login()`, tear down, or re-auth out of band.
 * The startup-time form of the same banner is handled fatally in runtime/startup.ts.
 */

import type { ElwoodWarningEvent } from "../core/types.ts";
import { isClaudeReauthRequiredText } from "./login/expiry-screen.ts";

export const LOGIN_RECOVERY_COMMAND = "/login" as const;

// The FIXED, content-free message and raw token. These are the canonical values the
// live `login_expired` warning always carries — never banner or session text
// (§5.7, C-CLAUDE-18).
export const LOGIN_EXPIRED_MESSAGE =
  "Claude's login expired mid-session; it cannot act until re-authenticated. Run /login (or session.login()) to recover.";
export const LOGIN_EXPIRED_RAW = "login_expired recovery=/login";

/**
 * Edge-detects the login-expired banner so the warning fires ONCE per occurrence.
 * Two-phase peek/commit: `peek` reports whether this frame is a fresh raised edge
 * WITHOUT mutating state, and `commit` advances to "present". The caller commits
 * BEFORE the live fan-out (warnings are live-only and fire exactly once — committing
 * after a throwing listener would re-fire the same incident to listeners that already
 * received it). A frame with no banner clears the flag immediately, so a banner that
 * clears and reappears is a genuinely new edge that warns again.
 */
export class LoginExpiredWatcher {
  private present = false;

  /** Whether this frame is a fresh raised edge (banner appears while absent). */
  peek(screenText: string): boolean {
    const visible = isClaudeReauthRequiredText(screenText);
    // A cleared banner re-arms immediately; only a NEW appearance needs a commit.
    if (!visible) {
      this.present = false;
      return false;
    }
    return !this.present;
  }

  /** Advance to "present" after the caller emits the live warning. */
  commit(): void {
    this.present = true;
  }

  /** Single-shot observe (peek + commit) for callers that emit unconditionally. */
  observe(screenText: string): boolean {
    if (!this.peek(screenText)) return false;
    this.commit();
    return true;
  }
}

export function loginExpiredWarning(elwoodSessionId: string): ElwoodWarningEvent {
  return {
    elwoodSessionId,
    agent: "claude",
    source: "terminal",
    code: "login_expired",
    severity: "warning",
    message: LOGIN_EXPIRED_MESSAGE,
    recoveryCommand: LOGIN_RECOVERY_COMMAND,
    raw: LOGIN_EXPIRED_RAW,
  };
}
