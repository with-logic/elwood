/**
 * Recognizes the probe shell's start line on its private control descriptor, which ends the
 * login shell's launch phase and starts the probe command's own bound. Implements PRD §9.2
 * and C-PERF-05.
 */

/**
 * The line a probe shell writes once the user's startup files have loaded, immediately before
 * the probe command runs. It separates the profile's launch time from the command's own bound
 * (PRD §9.2, C-PERF-05). Owned here, by the reader, so the runner never loads the shell
 * helpers that the writer, `probeShellCommand`, lives in.
 */
export const probeCommandStartLine = "elwood-probe-command-start";

/**
 * The descriptor the start line travels on: a fourth pipe the runner opens for every probe.
 * Not stdout or stderr, so a profile that redirects those (`exec 2>&1`, `exec 2>/dev/null`)
 * cannot hide the line, and captured output stays exactly the profile's and the command's.
 */
export const probeControlFd = 3;

/**
 * The probe shell's script prefix: it writes the start line, closes the descriptor so the
 * command does not inherit it, then the probe command runs.
 */
export const probeStartScript = `echo ${probeCommandStartLine} >&${probeControlFd}; exec ${probeControlFd}>&-; `;

/** Whether a probe runs a script that announces its command with the start line. */
export function announcesStart(args: readonly string[]): boolean {
  return args.at(-1)?.startsWith(probeStartScript) ?? false;
}

const startBytes = Buffer.from(`${probeCommandStartLine}\n`);

/** Finds the start line in a stream whose chunks may split it anywhere. */
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
    // Keep a copy of only what could still begin a split start line: a view would pin the
    // whole chunk for as long as an unresolved probe's reaper retains this watcher.
    this.tail = Buffer.from(window.subarray(Math.max(0, window.length - (startBytes.length - 1))));
    return false;
  }
}
