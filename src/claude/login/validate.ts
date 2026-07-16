/**
 * Input validation for the `/login` flow (PRD §5.3, C-API-43): a human-supplied
 * authorization code and a scraped browser URL are both untrusted, so each is
 * validated before it is written to the PTY or handed to a caller callback. A code
 * that could inject terminal controls, or a URL on an unapproved host, is rejected.
 */

const MAX_CODE_LENGTH = 512;
// Bracketed-paste sentinels, CR/LF, Escape, all C0/C1 controls, and Unicode line
// separators — any of which could end code entry and turn following bytes into
// live keystrokes. A valid authorization code is a single line of printable text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control input is the point.
const unsafeCodeChar = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Approved OAuth hosts the scraped login URL may point at (exact host match). */
const approvedAuthHosts: ReadonlySet<string> = new Set([
  "claude.ai",
  "claude.com",
  "platform.claude.com",
  "console.anthropic.com",
]);

/** A human authorization code is safe to submit as terminal input. */
export function isSafeAuthCode(code: string): boolean {
  return code.length > 0 && code.length <= MAX_CODE_LENGTH && !unsafeCodeChar.test(code);
}

/**
 * Parse a scraped authorization URL and return it ONLY when it is an `https:` URL
 * on an exactly-approved host with no embedded credentials; otherwise undefined,
 * so a spoofed `https://evilclaude.com/oauth/...` is never handed to the caller.
 */
export function safeAuthUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return approvedAuthHosts.has(url.hostname) ? url.toString() : undefined;
}
