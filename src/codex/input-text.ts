/** Match Codex’s Rust composer normalization (PRD §5.4/§5.8, C-API-70). */
/** Rust str::trim uses Unicode White_Space, which excludes U+FEFF. */
export function trimCodexWhitespace(value: string): string {
  const whitespace = /\p{White_Space}/u;
  let start = 0;
  let end = value.length;
  while (start < end && whitespace.test(value[start]!)) start++;
  while (end > start && whitespace.test(value[end - 1]!)) end--;
  return value.slice(start, end);
}

/** Normalize the forwarded bracketed paste for a native hook comparison. */
export function normalizeCodexPastedPayload(payload: string): string {
  return trimCodexWhitespace(payload.replace(/\r\n?/g, "\n"));
}
