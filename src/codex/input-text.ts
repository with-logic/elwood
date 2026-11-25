/** Match Codex’s Rust composer normalization (PRD §5.4/§5.8, C-API-70). */
/** Rust str::trim uses Unicode White_Space, which excludes U+FEFF. */
export function trimCodexWhitespace(value: string): string {
  const start = /^\p{White_Space}*/u.exec(value)![0].length;
  if (start === value.length) return "";
  // ECMAScript trims U+FEFF and keeps U+0085. Preserve the former and handle the
  // latter using a non-whitespace anchor so long suffixes need no per-unit test.
  let end = Math.max(value.trimEnd().length, value.lastIndexOf("\uFEFF") + 1);
  if (value[end - 1] === "\u0085") {
    const last = /(\P{White_Space})\p{White_Space}*$/u.exec(value)!;
    end = last.index + last[1]!.length;
  }
  return value.slice(start, end);
}

/** Normalize the forwarded bracketed paste for a native hook comparison. */
export function normalizeCodexPastedPayload(payload: string): string {
  return trimCodexWhitespace(payload.replace(/\r\n?/g, "\n"));
}
