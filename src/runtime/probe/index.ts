/**
 * Bounded one-shot subprocess probe used by the command-runner seam.
 * Implements PRD §9.2 bounded probe runtime/output (C-PERF-01, C-PERF-03, C-PERF-05,
 * C-PERF-07): a misbehaving CLI on PATH must not hang or flood memory during a `--version`,
 * `update`, or `--help` probe, a slow login-shell profile is bounded separately from the CLI
 * it launches, and only a few probes run at once. A probe runs in `options.cwd` when given
 * (§4.2, C-PTY-08).
 */

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { completeUtf8Length } from "../../core/utf8.ts";
import type { CommandOptions, CommandResult } from "../seams.ts";
import { abortProbe } from "./cleanup.ts";
import { withProbeSlot } from "./slots.ts";
import { announcesStart, ProbeStart, type ProbeStartChannel, probeControlFd } from "./start.ts";

/** The probe command's own default bound, from the shell's start line (C-PERF-03). */
export const probeCommandTimeoutMs = 15_000;
/**
 * The login shell's default bound, from spawn to its start line (C-PERF-05). Loading the
 * user's interactive profile took 7-19 s at 16 concurrent probes on a loaded host.
 */
export const probeLaunchTimeoutMs = 60_000;
const maxProbeOutputBytes = 1_000_000;
let commandTimeoutMs = probeCommandTimeoutMs;
let launchTimeoutMs = probeLaunchTimeoutMs;

/** Overrides each phase's bound. A direct test command never writes the start line, so it hits `launchMs`. */
export function setProbeTimeoutsForTests(bounds: {
  readonly commandMs: number;
  readonly launchMs: number;
}): void {
  commandTimeoutMs = bounds.commandMs;
  launchTimeoutMs = bounds.launchMs;
}

export function resetProbeTimeoutsForTests(): void {
  commandTimeoutMs = probeCommandTimeoutMs;
  launchTimeoutMs = probeLaunchTimeoutMs;
}

/** Accumulates stream chunks up to a hard byte cap, tracking overflow. */
class CappedBuffer {
  private chunks: Buffer[] = [];
  private byteLength = 0;
  overflowed = false;

  append(chunk: Buffer): void {
    // Once the cap is hit the probe is aborted and its pipes destroyed, so no chunk
    // ever arrives after `overflowed` is set; the first over-cap chunk is the last.
    const remaining = maxProbeOutputBytes - this.byteLength;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.byteLength = maxProbeOutputBytes;
      this.overflowed = true;
      return;
    }
    this.chunks.push(chunk);
    this.byteLength += chunk.length;
  }

  text(): string {
    // Byte capping can split a multibyte code point at the boundary. Drop any
    // incomplete trailing UTF-8 sequence so the decoded string re-encodes to
    // at most the byte cap (C-PERF-03) rather than growing via a replacement
    // character.
    const bytes = Buffer.concat(this.chunks);
    return bytes.subarray(0, completeUtf8Length(bytes)).toString("utf8");
  }

  release(): void {
    this.chunks = [];
  }
}

/** Runs one probe once a probe slot is free; its bounds start when it spawns (C-PERF-07). */
export function runProbe(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return withProbeSlot(() => spawnProbe(command, args, options));
}

function spawnProbe(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    // Probe shells are interactive so they load the same user PATH as the PTY launch. Give
    // them a fresh session: an interactive shell otherwise enables job control on Elwood's
    // controlling terminal and can leave its short-lived command's process group in the
    // foreground, causing headed cleanup to stop on SIGTTOU before restoring terminal modes.
    // A fourth pipe carries only the probe shell's start line, unless the shell closed it.
    const child = spawn(command, [...args], {
      detached: true,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const out = new CappedBuffer();
    const err = new CappedBuffer();
    // Node exposes the extra `pipe` in `stdio` as a Readable.
    const control = child.stdio[probeControlFd] as Readable;
    let settled = false;
    // Kill only when WE abort the probe (timeout/overflow); a normal exit or
    // spawn failure needs no signal (C-PERF-03).
    const settle = (result: CommandResult, kill = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      control.off("data", onControl); // a settled probe arms no command bound
      // The result already owns the decoded text. An unresolved probe's reaper retains the
      // child and its listeners, and through them these captures, so the chunks are dropped
      // here rather than left for the reaper to outlive. The listeners themselves stay: a
      // late `close` still has to find `settled` already true, which is the guard below.
      out.release();
      err.release();
      if (!kill) {
        resolve(result);
        return;
      }
      void abortProbe(child).then((cleanup) =>
        resolve({
          ...result,
          error: { ...result.error!, ...cleanup },
        }),
      );
    };
    const captured = (): [string, string] => [start.stripFromStdout(out.text()), err.text()];
    // Each phase's bound aborts the probe with its own typed timeout when it expires.
    const boundBy = (ms: number, result: () => CommandResult) => {
      const bound = setTimeout(() => settle(result(), true), ms);
      bound.unref?.();
      return bound;
    };
    const onData = (buffer: CappedBuffer) => (chunk: Buffer) => {
      buffer.append(chunk);
      if (out.overflowed || err.overflowed) settle(overflow(...captured()), true);
    };
    const start = new ProbeStart();
    const expectsStartLine = announcesStart(args);
    // A shell that closed the control descriptor writes the start line on stdout (start.ts).
    // Watched before capture, so a chunk that both starts the command and overflows the cap
    // has its bound cleared by the overflow's settle rather than armed after it.
    child.stdout.on("data", (chunk: Buffer) => onStart("stdout", chunk));
    child.stdout.on("data", onData(out));
    child.stderr.on("data", onData(err));
    // The start line ends the login shell's launch phase: the command's own bound begins
    // there, so the user's profile load is never charged to the CLI (C-PERF-05).
    function onStart(channel: ProbeStartChannel, chunk: Buffer): void {
      if (!start.feed(channel, chunk)) return;
      control.off("data", onControl);
      clearTimeout(timer);
      timer = boundBy(commandTimeoutMs, () => commandTimedOut(...captured()));
    }
    const onControl = (chunk: Buffer): void => onStart("control", chunk);
    control.on("data", onControl);
    // Spawn failure (e.g. ENOENT) fires `error` and not `close`. Node's spawn
    // `error` always carries a `code`, which preflight maps to `*_not_found`.
    child.on("error", (e: NodeJS.ErrnoException) => {
      const [stdout, stderr] = captured();
      settle({ status: null, stdout, stderr, error: { code: e.code, message: e.message } });
    });
    child.on("close", (code) => {
      const [stdout, stderr] = captured();
      // A shell that exits without announcing its command never ran it (an rc file that
      // `exec`s another program, say): its status says nothing about the CLI (C-PERF-05).
      if (expectsStartLine && !start.started) settle(shellExited(code, stdout, stderr));
      else settle({ status: code, stdout, stderr });
    });
    // The launch phase runs from spawn until the shell's start line (C-PERF-05).
    let timer = boundBy(launchTimeoutMs, () => launchTimedOut(...captured()));
  });
}

function commandTimedOut(stdout: string, stderr: string): CommandResult {
  const message = `probe timed out after ${commandTimeoutMs} ms`;
  return { status: null, stdout, stderr, error: { code: "ETIMEDOUT", message } };
}

function launchTimedOut(stdout: string, stderr: string): CommandResult {
  const message = `login shell did not start the probe command within ${launchTimeoutMs} ms`;
  const error = { code: "ETIMEDOUT", message, phase: "login_shell" } as const;
  return { status: null, stdout, stderr, error };
}

function shellExited(status: number | null, stdout: string, stderr: string): CommandResult {
  const message = `login shell exited with status ${status} before starting the probe command`;
  const error = { message, phase: "login_shell", shellStatus: status } as const;
  return { status: null, stdout, stderr, error };
}

function overflow(stdout: string, stderr: string): CommandResult {
  const message = `probe output exceeded ${maxProbeOutputBytes} bytes`;
  return { status: null, stdout, stderr, error: { code: "E2BIG", message } };
}
