/**
 * Quoting for the POSIX login shells both adapters launch through (PRD §4.2), kept apart from
 * `shell.ts` so a probe module can quote a path without loading the shell helpers that build
 * probe scripts (§9.2).
 */

/** Quotes one argument: wraps it in single quotes, escaping embedded single quotes as '\''. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
