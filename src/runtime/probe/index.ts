/**
 * Bounded one-shot subprocess probe used by the command-runner seam.
 * Implements PRD §9.2 bounded probe runtime/output (C-PERF-01, C-PERF-03, C-PERF-05,
 * C-PERF-07): a misbehaving CLI on PATH must not hang or flood memory during a `--version`,
 * `update`, or `--help` probe, a slow login-shell profile is bounded separately from the CLI
 * it launches, and only a few probes run at once. A probe the e2e home guard stops (PRD §12,
 * C-E2E-24) is a login-shell failure carrying only the guard's fixed reason.
 */

import type { Readable } from "node:stream";
import { exitStatus } from "../exit-status.ts";
import { homeGuardStopMarker, homeGuardStopped, watchForStopMarker } from "../home-guard/index.ts";
import type { CommandResult } from "../seams.ts";
import type { StreamMarkerWatcher } from "../stream-marker.ts";
import { type ProbeCapture, probeCapture } from "./capture.ts";
import { abortProbe } from "./cleanup.ts";
import { NamedPipeCapture } from "./named-pipes.ts";
import { ProbeProcess } from "./process.ts";
import {
  commandTimedOut,
  guardStopped,
  launchTimedOut,
  mapError,
  outputUnavailable,
  overflow,
  shellExited,
} from "./results.ts";
import { withProbeSlot } from "./slots.ts";
import { announcesStart, ProbeStart, type ProbeStartChannel, probeControlFd } from "./start.ts";

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
export function runProbe(command: string, args: readonly string[]): Promise<CommandResult> {
  return withProbeSlot(() => spawnProbe(command, args));
}

async function spawnProbe(command: string, args: readonly string[]): Promise<CommandResult> {
  let capture: ProbeCapture;
  try {
    capture = await probeCapture(args);
  } catch (error) {
    return outputUnavailable(error);
  }
  return spawnCaptured(command, args, capture);
}

function spawnCaptured(
  command: string,
  args: readonly string[],
  capture: ProbeCapture,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let process: ProbeProcess;
    try {
      process = new ProbeProcess(command, capture.args(args), capture instanceof NamedPipeCapture);
    } catch (error) {
      capture.release();
      throw error;
    }
    const child = process.child;
    // Node exposes the extra `pipe` in `stdio` as a Readable.
    const control = child.stdio[probeControlFd] as Readable;
    // Kill only when WE abort the probe (timeout/overflow); a normal exit or
    // spawn failure needs no signal (C-PERF-03).
    const settle = (result: CommandResult, kill = false): void => {
      clearTimeout(timer);
      control.off("data", onControl); // a settled probe arms no command bound
      child.stdout.off("data", onStdout);
      child.off("error", onError);
      process.detach();
      // Retained cleanup keeps liveness only: detach callbacks and release captured bytes
      // before it can outlive delivery of this result.
      capture.release();
      if (!kill) {
        process.release();
        resolve(result);
        return;
      }
      void abortProbe(child, true).then((cleanup) =>
        resolve({
          ...result,
          error: { ...result.error!, ...cleanup },
        }),
      );
    };
    const captured = (): [string, string] => {
      const [stdout, stderr] = capture.text();
      return [start.stripFromStdout(stdout), stderr];
    };
    // Each phase's bound aborts the probe with its own typed timeout, for its length, when it
    // expires.
    const boundBy = (ms: number, timedOut: typeof commandTimedOut) => {
      const bound = setTimeout(() => settle(timedOut(ms, ...captured()), true), ms);
      bound.unref?.();
      return bound;
    };
    const start = new ProbeStart();
    // Describes the script; start.started records whether its line was observed.
    const expectsStartLine = announcesStart(args);
    // A shell that closed the control descriptor writes the start line on stdout (start.ts).
    // Watched before capture, so a chunk that both starts the command and overflows the cap
    // has its bound cleared by the overflow's settle rather than armed after it.
    const onStdout = (chunk: Buffer) => {
      guardStop.feed(chunk);
      onStart("stdout", chunk);
    };
    child.stdout.on("data", onStdout);
    let exited: (() => CommandResult) | undefined;
    const finish = () => {
      if (exited && capture.ended()) settle(exited());
    };
    capture.watch(process.output, {
      overflowed: () => settle(overflow(...captured()), true),
      ended: finish,
    });
    // The start line ends the login shell's launch phase: the command's own bound begins
    // there, so the user's profile load is never charged to the CLI (C-PERF-05).
    function onStart(channel: ProbeStartChannel, chunk: Buffer): void {
      if (!start.feed(channel, chunk)) return;
      clearTimeout(timer);
      timer = boundBy(commandTimeoutMs, commandTimedOut);
    }
    // After the start line, the control descriptor carries only the e2e home guard's stop
    // line, which no profile's redirection of stdout can hide (PRD §12).
    const guardStop = watchForStopMarker();
    const onControl = (chunk: Buffer): void => {
      guardStop.feed(chunk);
      onStart("control", chunk);
    };
    control.on("data", onControl);
    // Spawn failure (e.g. ENOENT) fires `error` and not `close`. Node's spawn
    // `error` always carries a `code`, which preflight maps to `*_not_found`.
    function onError(e: NodeJS.ErrnoException): void {
      const [stdout, stderr] = captured();
      settle({ status: null, stdout, stderr, error: mapError(e) });
    }
    child.on("error", onError);
    process.onExit((code, signal) => {
      const [stdout, stderr] = captured();
      // A missing start line cannot establish which phase exited: a profile can close its
      // channels or exec another program. Do not report that status as the CLI's (C-PERF-05).
      if (expectsStartLine && !start.started) settle(shellExited(code, stdout, stderr));
      // The e2e home guard runs after the start line but stops the shell before the command.
      else if (
        expectsStartLine &&
        homeGuardStopped(code, () => hasHomeGuardStopMarker(stdout, guardStop))
      )
        settle(guardStopped(stdout, stderr));
      // A signal death reads as a shell reports it, 128+n.
      else {
        exited = () => {
          const [stdout, stderr] = captured();
          return { status: exitStatus(code, signal), stdout, stderr };
        };
        finish();
      }
    });
    // The launch phase runs from spawn until the shell's start line (C-PERF-05).
    let timer = boundBy(launchTimeoutMs, launchTimedOut);
  });
}

/** Whether the guard's stop line reached the control descriptor or, from a shell that closed it, stdout. */
function hasHomeGuardStopMarker(stdout: string, stopWatcher: StreamMarkerWatcher): boolean {
  return stopWatcher.seen || stdout.includes(homeGuardStopMarker);
}
