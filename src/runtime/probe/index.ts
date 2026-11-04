/** Bounded probes, owned cleanup and home-guard reporting (PRD §9.2/§12, C-PERF-03/05/07, C-E2E-24). */

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { toError } from "../../core/errors.ts";
import { exitStatus } from "../exit-status.ts";
import { homeGuardStopMarker, homeGuardStopped, watchForStopMarker } from "../home-guard/index.ts";
import type { CommandOptions, CommandResult } from "../seams.ts";
import { type ProbeCapture, probeCapture } from "./capture.ts";
import { abortProbe } from "./cleanup.ts";
import { ProbeCommandLookup } from "./lookup.ts";
import { NamedPipeCapture } from "./named-pipes.ts";
import { ProbeProcess } from "./process.ts";
import {
  type AbortResult,
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
export function runProbe(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return withProbeSlot(() => spawnProbe(command, args, options));
}

async function spawnProbe(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  let capture: ProbeCapture;
  try {
    capture = await probeCapture(args);
  } catch (error) {
    return outputUnavailable(error);
  }
  try {
    // Keep native shell-path diagnostics: a supervisor’s status cannot carry errno fields.
    if ((capture instanceof NamedPipeCapture || announcesStart(args)) && command.includes("/"))
      await access(resolve(options.cwd ?? process.cwd(), command), constants.X_OK);
  } catch (error) {
    capture.release();
    return {
      started: false,
      status: null,
      stdout: "",
      stderr: "",
      error: mapError(toError(error)),
    };
  }
  return spawnCaptured(command, args, capture, options);
}

function spawnCaptured(
  command: string,
  args: readonly string[],
  capture: ProbeCapture,
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let process: ProbeProcess;
    try {
      process = new ProbeProcess(
        command,
        capture.args(args),
        capture instanceof NamedPipeCapture || announcesStart(args),
        options,
      );
    } catch (error) {
      capture.release();
      throw error;
    }
    const child = process.child;
    const control = child.stdio[probeControlFd] as Readable;
    const releaseCapture = (): void => {
      clearTimeout(timer);
      control.off("data", onControl);
      child.stdout.off("data", onStdout);
      child.off("error", onError);
      process.detach();
      capture.release();
    };
    const settle = (result: CommandResult): void => {
      releaseCapture();
      process.release();
      resolve(result);
    };
    const abort = (result: AbortResult): void => {
      releaseCapture();
      void abortProbe(child, { keepEventLoopAlive: true }).then((cleanup) =>
        resolve({ ...result, error: { ...result.error, ...cleanup } }),
      );
    };
    const captured = (): [string, string] => {
      const [stdout, stderr] = capture.text();
      return [
        capture instanceof NamedPipeCapture
          ? stdout
          : lookup.stripFromStdout(start.stripFromStdout(stdout)),
        stderr,
      ];
    };
    const boundBy = (ms: number, timedOut: typeof commandTimedOut) => {
      const bound = setTimeout(() => abort(timedOut(ms, ...captured())), ms);
      bound.unref?.();
      return bound;
    };
    const start = new ProbeStart();
    const lookup = new ProbeCommandLookup();
    const expectsStartLine = announcesStart(args);
    const onStdout = (chunk: Buffer) => {
      guardStop.feed(chunk);
      lookup.feed("stdout", chunk);
      onStart("stdout", chunk);
    };
    child.stdout.on("data", onStdout);
    let exitResultFactory: (() => CommandResult) | undefined;
    const finish = () => {
      if (exitResultFactory && capture.ended()) settle(exitResultFactory());
    };
    capture.watch(process.output, {
      overflowed: () => abort(overflow(...captured())),
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
      lookup.feed("control", chunk);
      onStart("control", chunk);
    };
    control.on("data", onControl);
    function onError(e: NodeJS.ErrnoException): void {
      const [stdout, stderr] = captured();
      settle({ started: false, status: null, stdout, stderr, error: mapError(e) });
    }
    child.on("error", onError);
    process.onExit((code, signal) => {
      // Every result waits for FIFO EOF, including an unobserved start line. The owner
      // remains alive, and the outstanding phase bound still kills silent inherited writers.
      exitResultFactory = () => {
        const [stdout, stderr] = captured();
        if (expectsStartLine && !start.started) return shellExited(code, stdout, stderr);
        if (
          expectsStartLine &&
          homeGuardStopped(code, () => guardStop.seen || stdout.includes(homeGuardStopMarker))
        )
          return guardStopped(stdout, stderr);
        return { status: exitStatus(code, signal), stdout, stderr, ...lookup.result(code) };
      };
      finish();
    });
    // The launch phase runs from spawn until the shell's start line (C-PERF-05).
    let timer = boundBy(launchTimeoutMs, launchTimedOut);
  });
}
