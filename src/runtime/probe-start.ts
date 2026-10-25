/**
 * Recognizes the probe shell's start line on stderr, which ends the login shell's launch
 * phase and starts the probe command's own bound. Implements PRD §9.2 and C-PERF-05.
 */

/**
 * The line a probe shell writes to stderr once the user's startup files have loaded,
 * immediately before the probe command runs. It separates the profile's launch time
 * from the command's own bound (PRD §9.2, C-PERF-05). Owned here, by the reader, so the
 * runner never loads the shell helpers that the writer, `probeShellCommand`, lives in.
 */
export const probeCommandStartLine = "elwood-probe-command-start";

/** The probe shell's script prefix: it writes the start line, then the probe command runs. */
export const probeStartScript = `echo ${probeCommandStartLine} >&2; `;

/** Whether a probe runs a script that announces its command with the start line. */
export function announcesStart(args: readonly string[]): boolean {
  return args.at(-1)?.startsWith(probeStartScript) ?? false;
}

const startLine = `${probeCommandStartLine}\n`;
const startBytes = Buffer.from(startLine);

/** Finds the start line in a stderr stream whose chunks may split it anywhere. */
export class ProbeStartWatcher {
  private tail = Buffer.alloc(0);
  private seen = false;

  /** Whether the start line has been seen: the probe command has begun. */
  get started(): boolean {
    return this.seen;
  }

  /** True exactly once: for the chunk that completes the start line. */
  feed(chunk: Buffer): boolean {
    if (this.seen) return false;
    const window = Buffer.concat([this.tail, chunk]);
    if (window.includes(startBytes)) {
      this.seen = true;
      this.tail = Buffer.alloc(0);
      return true;
    }
    // Keep only what could still begin a start line split across chunks.
    this.tail = window.subarray(Math.max(0, window.length - (startBytes.length - 1)));
    return false;
  }
}

/** Captured stderr without the shell's start line, which is Elwood's, not the CLI's. */
export function withoutStartLine(stderr: string): string {
  return stderr.replace(startLine, "");
}
