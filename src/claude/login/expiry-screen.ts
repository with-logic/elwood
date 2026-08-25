/**
 * Recognizer for Claude's re-authentication-required screens (PRD §5.3,
 * C-CLAUDE-17/18). The Claude CLI shows these when a login lapses or is revoked
 * and the session can no longer act until the human re-runs `/login`. Owned by the
 * Claude login area (not generic startup infra) because it is Claude-specific and
 * version-coupled to that CLI's wording (v2.1.x).
 *
 * Recognized as INDEPENDENT linear searches (no unbounded backtracking, since
 * this runs on every rendered frame): a lapsed-or-absent-login phrase AND a
 * `/login` recovery directive both present, or the self-contained
 * "run /login to sign in" directive on its own. Anchoring on the directive stops
 * an unrelated mention of "login" from tripping it.
 *
 * The lapsed-login phrase covers a session that expired/was revoked mid-run
 * (`Login expired`, `Session expired`, `OAuth token revoked`) as well as an
 * outright signed-out session (`Not logged in`, which Claude renders when auth is
 * dropped entirely). All four are the same recovery for the caller — re-run
 * `/login` — so they map to one banner. The startup path already flags the
 * single-line `not logged in` form; recognizing it here closes the MID-SESSION gap
 * (a ready session that logs out and shows "Not logged in · Run /login").
 */

const lapsedLoginPhrase =
  /(?:(?:login|session|oauth token)\s+(?:expired|revoked)|not\s+logged\s+in)/i;
const runLoginDirective = /(?:run|please run)\s+\/login/i;
const runLoginToSignIn = /(?:run|please run)\s+\/login\s+to\s+sign in/i;

/** Whether the text shows a Claude re-authentication-required banner. */
export function isClaudeReauthRequiredText(text: string): boolean {
  if (runLoginToSignIn.test(text)) return true;
  return lapsedLoginPhrase.test(text) && runLoginDirective.test(text);
}
