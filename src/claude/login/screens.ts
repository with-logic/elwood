/**
 * Screen matchers for Claude's interactive `/login` flow (PRD §5.3, C-API-43).
 * Each regex recognizes one stage of the real CLI flow so the driver can detect
 * which screen is showing and react. Matched on the rendered snapshot text; the
 * literal strings mirror the CLI's own wording (v2.1.x).
 */

/** The "Select login method" list that `/login` shows before authorizing. */
export const methodPickerVisible = /select login method/i;

/** The screen that offers/opens the browser authorization URL. */
export const authUrlVisible =
  /authenticate your account at|browser didn'?t open|opening browser to authorize|if the browser didn'?t open, visit/i;

/** The manual authorization-code entry prompt (default account flow). */
export const pasteCodePrompt = /paste code here/i;

/** A successful login. */
export const loginSucceeded = /login(?: successful| successful\.)|logged in as|login successful/i;

/** An explicit login failure or a rejected/invalid authorization code. */
export const loginFailed =
  /login failed|oauth (?:login failed|error)|invalid code|failed to exchange authorization code/i;

/** A `claude.ai`/console OAuth authorize URL, captured from the screen if present. */
const authUrlCapture =
  /(https?:\/\/[^\s'"]*(?:claude\.com|claude\.ai|anthropic\.com)\/oauth[^\s'"]*)/i;

/** Extract the first authorization URL on screen, or undefined when none is shown yet. */
export function extractAuthUrl(text: string): string | undefined {
  return authUrlCapture.exec(text)?.[1];
}
