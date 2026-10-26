/**
 * The probe shell's scripts, and recognition of their start line, which ends the login shell's
 * launch phase and starts the probe command's own bound: on the runner's private control
 * descriptor, or on stdout from a shell that closed that descriptor at startup. Implements
 * PRD §9.2 and C-PERF-05.
 */

import { randomBytes } from "node:crypto";
import { probeOutputRedirect } from "./capture.ts";

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
 * The start line's primary channel: a fourth pipe the runner opens for every probe. Not stdout
 * or stderr, so a profile that redirects those (`exec 2>&1`, `exec 2>/dev/null`) cannot hide
 * the line. A shell that closed it at startup is started by the line's stdout copy instead
 * (`probeStartScript`).
 */
export const probeControlFd = 3;

/**
 * The probe shell's script prefix: it writes the start line on the control descriptor and
 * closes it, so the command does not inherit it, then writes the line on stdout. macOS's bash
 * 3.2 started with both `-l` and `-i` closes every inherited descriptor above stderr before
 * running the script, so there the first write fails, silently, and the stdout copy starts the
 * command's bound instead. Not stderr: a profile may send that to `/dev/null` or into stdout,
 * while a profile that hid stdout would hide the command's own output and fail the probe
 * anyway. Each write tolerates a closed stream, so a startup file's `errexit` cannot end the
 * shell before its command.
 */
export const probeStartScript = `if { echo ${probeCommandStartLine} >&${probeControlFd}; } 2>/dev/null; then exec ${probeControlFd}>&-; fi; { echo ${probeCommandStartLine}; } 2>/dev/null || :; `;

/**
 * A probe's whole script: the start line, then `exec` of the command with its stdout and stderr
 * redirected into the runner's private output files (`capture.ts`). After `exec` no shell code
 * runs (no trap, no EXIT trap, no `.zlogout`), and nothing the startup files started holds
 * those files, so they hold only the command's output. The probe's process is the command
 * itself, so its exit status is the command's and a bound's signal reaches it directly.
 * `command` is one simple command the shell can `exec`: a program and its arguments.
 */
export function probeScript(command: string): string {
  return `${probeStartScript}exec ${command} ${probeOutputRedirect}`;
}

/**
 * A probe answered by its exit status alone, for a shell builtin such as `command -v` (bash
 * `exec`s only programs). Its output goes to `/dev/null`, so nothing is captured.
 */
export function probeStatusScript(command: string): string {
  return `${probeStartScript}${command} >/dev/null 2>&1`;
}

/** Whether a probe runs a script that announces its command with the start line. */
export function announcesStart(args: readonly string[]): boolean {
  return args.at(-1)?.includes(probeStartScript) ?? false;
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

/** The two streams watched for a probe's start line: the control descriptor and stdout. */
export type ProbeStartChannel = "control" | "stdout";

/** Watches both channels; the first to carry the start line starts the command. */
export class ProbeStart {
  /** Whether the probe's script will write the start line; whether it has is `started`. */
  readonly expectsStartLine: boolean;

  constructor(args: readonly string[]) {
    this.expectsStartLine = announcesStart(args);
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
}
