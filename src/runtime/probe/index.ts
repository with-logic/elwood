/**
 * Bounded one-shot subprocess probe used by the command-runner seam.
 * Implements PRD §9.2 bounded probe runtime/output (C-PERF-01, C-PERF-03, C-PERF-05,
 * C-PERF-07): a misbehaving CLI on PATH must not hang or flood memory during a `--version`,
 * `update`, or `--help` probe, a slow login-shell profile is bounded separately from the CLI
 * it launches, and only a few probes run at once. A probe runs in `options.cwd` (§4.2).
 */

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { exitStatus } from "../exit-status.ts";
import type { CommandOptions, CommandResult } from "../seams.ts";
import { maxProbeStreamOutputBytes } from "./capped-buffer.ts";
import { type ProbeCapture, probeCapture } from "./capture.ts";
import { abortProbe } from "./cleanup.ts";
import { withProbeSlot } from "./slots.ts";
import { ProbeStart, type ProbeStartChannel, probeControlFd } from "./start.ts";

/** The probe command's own default bound, from the shell's start line (C-PERF-03). */
export const probeCommandTimeoutMs = 15_000;
/**
 * The login shell's default bound, from spawn to its start line (C-PERF-05). Loading the
 * user's interactive profile took 7-19 s at 16 concurrent probes on a loaded host.
 */
export const probeLaunchTimeoutMs = 60_000;
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

/** Runs one probe once a probe slot is free; its bounds start when it spawns (C-PERF-07). */
export function runProbe(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const spawnWith = (capture: ProbeCapture) => spawnCaptured(command, args, options, capture);
  return withProbeSlot(() => probeCapture(args).then(spawnWith, outputUnavailable));
}

function spawnCaptured(
  command: string,
  args: readonly string[],
  options: CommandOptions,
  capture: ProbeCapture,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const start = new ProbeStart(args);
    // Probe shells are interactive so they load the same user PATH as the PTY launch. Give
    // them a fresh session: an interactive shell otherwise enables job control on Elwood's
    // controlling terminal and can leave its short-lived command's process group in the
    // foreground, causing headed cleanup to stop on SIGTTOU before restoring terminal modes.
    // A fourth pipe carries only the probe shell's start line, unless the shell closed it.
    const child = releasedOnThrow(capture, () =>
      spawn(command, [...args], {
        detached: true,
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        env: capture.env,
      }),
    );
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
      // The result already owns the decoded text; every settle path drops the capture. The
      // listeners stay: a late `close` still has to find `settled` already true.
      capture.release();
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
    // Read when a bound fires, before its signal: nothing written after it is kept.
    const captured = (): [string, string] => capture.text();
    // Each phase's bound aborts the probe with its own typed timeout when it expires.
    const boundBy = (ms: number, result: () => CommandResult) => {
      const bound = setTimeout(() => settle(result(), true), ms);
      bound.unref?.();
      return bound;
    };
    // A shell that closed the control descriptor writes the start line on stdout (start.ts).
    // Watched before a direct command's capture, so a chunk that both starts the command and
    // overflows the cap has its bound cleared by the overflow's settle, not armed after it.
    child.stdout.on("data", (chunk: Buffer) => onStart("stdout", chunk));
    // The probe ends once its process has closed and its capture has ended, in either order:
    // a command's heirs can hold its output open after it exits, as they can a pipe.
    let exited: (() => CommandResult) | undefined;
    const finish = () => exited && capture.ended() && settle(exited());
    capture.watch(child, {
      overflowed: () => settle(overflow(...captured()), true),
      ended: finish,
    });
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
      settle({ status: null, stdout, stderr, error: mapError(e) });
    });
    child.on("close", (code, signal) => {
      // A shell that exits without announcing its command never ran it (an rc file that
      // `exec`s another program, say): its status says nothing about the CLI (C-PERF-05).
      if (start.expectsStartLine && !start.started) {
        settle(shellExited(code, ...captured()));
        return;
      }
      // A signal death reads as a shell reports it, 128+n.
      exited = () => ({ status: exitStatus(code, signal), ...output(captured()) });
      finish();
    });
    // The launch phase runs from spawn until the shell's start line (C-PERF-05).
    let timer = boundBy(launchTimeoutMs, () => launchTimedOut(...captured()));
  });
}

function output([stdout, stderr]: [string, string]) {
  return { stdout, stderr };
}

/** Runs `spawnIt`; a spawn that throws leaves no output directory behind. */
function releasedOnThrow<T>(capture: ProbeCapture, spawnIt: () => T): T {
  try {
    return spawnIt();
  } catch (error) {
    capture.release();
    throw error;
  }
}

function mapError(error: NodeJS.ErrnoException): {
  readonly code?: string | undefined;
  readonly message: string;
} {
  return { code: error.code, message: error.message };
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

function outputUnavailable(error: NodeJS.ErrnoException): CommandResult {
  const message = `could not create the probe's private output pipes: ${error.message}`;
  const code = typeof error.code === "string" ? { code: error.code } : {};
  return { status: null, stdout: "", stderr: "", error: { message, ...code } };
}

function overflow(stdout: string, stderr: string): CommandResult {
  const message = `a probe output stream exceeded ${maxProbeStreamOutputBytes} bytes`;
  return { status: null, stdout, stderr, error: { code: "E2BIG", message } };
}
