/** POSIX shell argument quoting and login tuple shared below runtime/PTY (PRD §4.2). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export type LoginShellArgs = readonly ["-l", "-i", "-c", string];
