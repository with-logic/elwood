/**
 * Recognizes the probe shell's start line, which ends the login shell's launch phase and starts
 * the probe command's own bound: on the runner's private control descriptor, or on stdout from a
 * shell that closed that descriptor at startup. The start and end lines also bracket the
 * command's own output on stdout and stderr, so the shell's startup and exit output is never
 * captured as the command's. Implements PRD §9.2 and C-PERF-05.
 */

import { randomBytes } from "node:crypto";

/**
 * The line a probe shell writes once the user's startup files have loaded, immediately before
 * the probe command runs. It separates the profile's launch time from the command's own bound
 * (PRD §9.2, C-PERF-05). Owned here, by the reader, so the runner never loads the shell
 * helpers that the writer, `probeShellCommand`, lives in. It ends in a token drawn once per
 * parent process: stdout, which the runner also watches, carries the profile's own output,
 * and no profile can print a line it cannot predict.
 */
export const probeCommandStartLine = `elwood-probe-command-start-${randomBytes(8).toString("hex")}`;

/**
 * The line a probe shell writes on stdout and stderr once the probe command has exited, before
 * the shell's own exit work: zsh runs a startup file's EXIT trap and `.zlogout` after a `-c`
 * command, and both can print. It carries the start line's token, so no output can pass for it.
 */
export const probeCommandEndLine = `${probeCommandStartLine}-end`;

/**
 * The start line's primary channel: a fourth pipe the runner opens for every probe. Not stdout
 * or stderr, so a profile that redirects those (`exec 2>&1`, `exec 2>/dev/null`) cannot hide
 * the line. A shell that closed it at startup is started by the line's stdout copy instead
 * (`probeStartScript`).
 */
export const probeControlFd = 3;

/**
 * The probe shell's script prefix: it writes the start line on the control descriptor and
 * closes it, so the command does not inherit it, then writes the line on stdout and on stderr,
 * and the probe command runs. macOS's bash 3.2 started with both `-l` and `-i` closes every
 * inherited descriptor above stderr before running the script, so there the first write fails,
 * silently, and the stdout copy starts the command's bound instead. Not stderr: a profile may
 * send that to `/dev/null` or into stdout, while a profile that hid stdout would hide the
 * command's own output and fail the probe anyway. The stdout and stderr copies also mark where
 * the startup files' output ends on each stream (`commandOutput`).
 */
export const probeStartScript = `if { echo ${probeCommandStartLine} >&${probeControlFd}; } 2>/dev/null; then exec ${probeControlFd}>&-; fi; echo ${probeCommandStartLine}; echo ${probeCommandStartLine} >&2; `;

/**
 * The probe shell's whole script. After the command it keeps the command's exit status (128+n
 * for a signal death, as `$?` reports it), writes the end line on stdout and stderr, and exits
 * with that status. The `&&`/`||` list keeps a startup file's `errexit` from leaving before the
 * end line, and the braces and newline take any command list. The shell does not `exec` the
 * command, so a probe's process group holds the shell as well as the command, and a bound kills
 * the whole group (C-PERF-03).
 */
export function probeScript(command: string): string {
  const status = "elwood_probe_status";
  const end = `echo ${probeCommandEndLine}; echo ${probeCommandEndLine} >&2`;
  return `${probeStartScript}{ ${command}\n} && ${status}=0 || ${status}=$?; ${end}; (exit $${status})`;
}

/** Whether a probe runs a script that announces its command with the start line. */
export function announcesStart(args: readonly string[]): boolean {
  return args.at(-1)?.includes(probeStartScript) ?? false;
}

const startText = `${probeCommandStartLine}\n`;
const startBytes = Buffer.from(startText);
const endText = `${probeCommandEndLine}\n`;

/**
 * One captured stream's output from the probe command alone (PRD §9.2): what follows the start
 * line and precedes the end line, wherever on a line either falls, so a last line without a
 * newline is kept. A stream without the start line never carried the command's output (the shell
 * never reached it, or a startup file redirected the stream), so nothing is kept. Without the end
 * line the command was cut off by a bound or the byte cap, and everything after the start is its
 * own. A second start line, which a profile that merged stderr into stdout adds, is dropped.
 */
export function commandOutput(captured: string): string {
  const start = captured.indexOf(startText);
  if (start < 0) return "";
  const output = captured.slice(start + startText.length);
  const end = output.indexOf(endText);
  return (end < 0 ? output : output.slice(0, end)).replaceAll(startText, "");
}

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

/** The two streams a probe's start line can arrive on. */
export type ProbeStartChannel = "control" | "stdout";

/** Watches both channels; the first to carry the start line starts the command. */
export class ProbeStart {
  /** Whether the probe's script announces its command with the start line. */
  readonly announced: boolean;

  constructor(args: readonly string[]) {
    this.announced = announcesStart(args);
  }

  // One watcher per channel: a channel added to `ProbeStartChannel` must be given its own.
  private readonly watchers: Readonly<Record<ProbeStartChannel, ProbeStartWatcher>> = {
    control: new ProbeStartWatcher(),
    stdout: new ProbeStartWatcher(),
  };

  /** Whether any channel has carried the start line. */
  get started(): boolean {
    return Object.values(this.watchers).some((watcher) => watcher.started);
  }

  /** True exactly once across both channels: for the chunk that completes the start line. */
  feed(channel: ProbeStartChannel, chunk: Buffer): boolean {
    if (this.started) return false; // later copies are the command's own output
    return this.watchers[channel].feed(chunk);
  }

  /**
   * What a probe keeps of one captured stream: only the command's own output when the script
   * announces it, because the login shell's startup and exit output can hold expanded secrets
   * and diagnostics are built from this capture (§9.2). A direct test command keeps it all.
   */
  kept(captured: string): string {
    return this.announced ? commandOutput(captured) : captured;
  }
}
