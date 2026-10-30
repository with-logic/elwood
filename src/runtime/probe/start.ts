/**
 * Recognizes the probe shell's start line, which ends the login shell's launch phase and starts
 * the probe command's own bound: on the runner's private control descriptor, or on stdout from a
 * shell that closed that descriptor at startup. Implements PRD §9.2 and C-PERF-05.
 */

import { randomBytes } from "node:crypto";
import { StreamMarkerWatcher } from "../stream-marker.ts";

/**
 * The line a probe shell writes once the user's startup files have loaded, before the probe
 * command runs. It separates the profile's launch time from the command's own bound, which
 * covers everything after the line: the not-found handlers' removal, then the command
 * (PRD §9.2, C-PERF-05). Owned here, by the reader, so the runner never loads the shell
 * helpers that the writer, `probeShellCommand`, lives in. It ends in a token drawn once per
 * parent process: stdout, which the runner also watches, carries the profile's own output,
 * and no profile can print a line it cannot predict.
 */
export const probeCommandStartLine = `elwood-probe-command-start-${randomBytes(8).toString("hex")}`;

/**
 * The start line's primary channel: a fourth pipe the runner opens for every probe. Not stdout
 * or stderr, so a profile that redirects those (`exec 2>&1`, `exec 2>/dev/null`) cannot hide
 * the line, and captured output stays exactly the profile's and the command's. A shell that
 * closed it at startup writes the line on stdout instead (`probeStartScript`).
 */
export const probeControlFd = 3;

/**
 * The probe shell's script prefix: it writes the start line on the control descriptor. macOS's
 * bash 3.2 started with both `-l` and `-i` closes every inherited descriptor above stderr before
 * running the script, so there the write fails, silently, and the line goes to stdout. Not
 * stderr: a profile may send that to `/dev/null` or into stdout, while a profile that hid stdout
 * would hide the line, and so fail the probe as the login shell's. The runner removes the line
 * from captured stdout. The descriptor stays open for the e2e home guard, which writes its stop
 * line where the start line went (PRD §12), until `probeControlClose`.
 */
export const probeStartScript = `{ echo ${probeCommandStartLine} >&${probeControlFd}; } 2>/dev/null || echo ${probeCommandStartLine}; `;

/** Closes the control descriptor before the probe command, so the command does not inherit it. */
export const probeControlClose = `exec ${probeControlFd}>&-; `;

/**
 * Removes the user's not-found handlers before the probe command runs: zsh's
 * `command_not_found_handler` and bash's `command_not_found_handle`. A shell that finds no
 * command runs its handler, so its output would be captured as the command's, and the status
 * the handler returns would replace the 127 that tells preflight the CLI is missing. Each
 * shell ignores the other's name, and a failed `unset` cannot end the shell under `errexit`.
 */
export const probeNotFoundHandlerReset =
  "unset -f command_not_found_handler command_not_found_handle 2>/dev/null || :; ";

/** Whether a probe runs a script that announces its command with the start line. */
export function announcesStart(args: readonly string[]): boolean {
  return args.at(-1)?.startsWith(probeStartScript) ?? false;
}

const startText = `${probeCommandStartLine}\n`;
const startBytes = Buffer.from(startText);

/** The two streams a probe's start line can arrive on. */
export type ProbeStartChannel = "control" | "stdout";

/** Watches both channels; the first to carry the start line starts the command. */
export class ProbeStart {
  // One watcher per channel: a channel added to `ProbeStartChannel` must be given its own.
  private readonly watchers: Readonly<Record<ProbeStartChannel, StreamMarkerWatcher>> = {
    control: new StreamMarkerWatcher(startBytes),
    stdout: new StreamMarkerWatcher(startBytes),
  };

  /** Whether any channel has carried the start line. */
  get started(): boolean {
    return Object.values(this.watchers).some((watcher) => watcher.seen);
  }

  /** True exactly once across both channels: for the chunk that completes the start line. */
  feed(channel: ProbeStartChannel, chunk: Buffer): boolean {
    if (this.started) return false; // later copies are the command's own output
    return this.watchers[channel].feed(chunk);
  }

  /** Removes the start line from captured stdout if the shell wrote it there (C-PERF-05). */
  stripFromStdout(captured: string): string {
    return this.watchers.stdout.seen ? captured.replace(startText, "") : captured;
  }
}
