/** One captured probe’s event wiring, phase bounds and output ownership (PRD §9.2, C-PERF-03/05). */
import type { Readable } from "node:stream";
import { exitStatus } from "../exit-status.ts";
import { homeGuardStopMarker, homeGuardStopped, watchForStopMarker } from "../home-guard/index.ts";
import type { CommandOptions, CommandResult } from "../seams.ts";
import type { ProbeCapture } from "./capture.ts";
import { abortProbe } from "./cleanup.ts";
import { checkedProbeCommand, ProbeDirectoryRefusal } from "./directory.ts";
import { ProbeCommandLookup } from "./lookup.ts";
import { NamedPipeCapture } from "./named-pipes.ts";
import { ProbeProcess } from "./process.ts";
import {
  type AbortResult,
  commandTimedOut,
  guardStopped,
  launchTimedOut,
  mapError,
  overflow,
  shellExited,
} from "./results.ts";
import { announcesStart, ProbeStart, type ProbeStartChannel, probeControlFd } from "./start.ts";

/** Read each bound at its phase transition, including overrides made while a probe is running. */
type ProbeTimeouts = { readonly launch: () => number; readonly command: () => number };

export function runCapturedProbe(
  command: string,
  args: readonly string[],
  capture: ProbeCapture,
  options: CommandOptions,
  timeouts: ProbeTimeouts,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const run = new ProbeRun(command, args, capture, options, timeouts, resolve);
    run.start();
  });
}

class ProbeRun {
  private readonly capture: ProbeCapture;
  private readonly timeouts: ProbeTimeouts;
  private readonly resolve: (result: CommandResult) => void;
  private readonly process: ProbeProcess;
  private readonly control: Readable;
  private readonly startMarker = new ProbeStart();
  private readonly lookup = new ProbeCommandLookup();
  private readonly guardStop = watchForStopMarker();
  private readonly expectsStartLine: boolean;
  private readonly directory: ProbeDirectoryRefusal;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private commandExit:
    | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
    | undefined;

  constructor(
    command: string,
    args: readonly string[],
    capture: ProbeCapture,
    options: CommandOptions,
    timeouts: ProbeTimeouts,
    resolve: (result: CommandResult) => void,
  ) {
    this.capture = capture;
    this.timeouts = timeouts;
    this.resolve = resolve;
    this.directory = new ProbeDirectoryRefusal(options);
    try {
      const launch = checkedProbeCommand(command, capture.args(args), options);
      this.process = new ProbeProcess(
        launch.command,
        launch.args,
        capture instanceof NamedPipeCapture || announcesStart(args),
        options,
      );
    } catch (error) {
      capture.release();
      throw error;
    }
    this.control = this.process.child.stdio[probeControlFd] as Readable;
    this.expectsStartLine = announcesStart(args);
  }

  start(): void {
    const child = this.process.child;
    child.stdout.on("data", this.onStdout);
    this.capture.watch(this.process.output, { overflowed: this.onOverflow, ended: this.finish });
    this.control.on("data", this.onControl);
    child.on("error", this.onError);
    this.process.onExit(this.onExit);
    this.timer = this.boundBy(this.timeouts.launch(), launchTimedOut);
  }

  private capturedOutput(): [string, string] {
    const [stdout, stderr] = this.capture.text();
    return [
      this.capture instanceof NamedPipeCapture
        ? stdout
        : this.lookup.stripFromStdout(this.startMarker.stripFromStdout(stdout)),
      stderr,
    ];
  }

  private onStart(channel: ProbeStartChannel, chunk: Buffer): void {
    if (!this.startMarker.feed(channel, chunk)) return;
    clearTimeout(this.timer);
    this.timer = this.boundBy(this.timeouts.command(), commandTimedOut);
  }

  private readonly onStdout = (chunk: Buffer): void => {
    this.guardStop.feed(chunk);
    this.directory.feed("stdout", chunk);
    this.lookup.feed("stdout", chunk);
    this.onStart("stdout", chunk);
  };

  private readonly onControl = (chunk: Buffer): void => {
    this.guardStop.feed(chunk);
    this.directory.feed("control", chunk);
    this.lookup.feed("control", chunk);
    this.onStart("control", chunk);
  };

  private readonly onError = (error: NodeJS.ErrnoException): void => {
    const [stdout, stderr] = this.capturedOutput();
    this.settle({ status: null, stdout, stderr, error: mapError(error) });
  };

  private readonly onOverflow = (): void => this.abort(overflow(...this.capturedOutput()));

  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    // Command exit keeps the supervisor alive; its phase bound still owns inherited FIFO writers.
    this.commandExit = { code, signal };
    this.finish();
  };

  private readonly finish = (): void => {
    if (this.commandExit && this.capture.ended())
      this.settle(this.exitResult(this.commandExit.code, this.commandExit.signal));
  };

  private exitResult(code: number | null, signal: NodeJS.Signals | null): CommandResult {
    const [stdout, stderr] = this.capturedOutput();
    const refusal = this.directory.result(code);
    if (refusal !== undefined) return refusal;
    if (this.expectsStartLine && !this.startMarker.started)
      return shellExited(code, stdout, stderr);
    if (
      this.expectsStartLine &&
      homeGuardStopped(code, () => this.guardStop.seen || stdout.includes(homeGuardStopMarker))
    )
      return guardStopped(stdout, stderr);
    return { status: exitStatus(code, signal), stdout, stderr, ...this.lookup.result(code) };
  }

  private settle(result: CommandResult): void {
    this.releaseCapture();
    this.process.acknowledgeOutputDrained();
    this.resolve(result);
  }

  private abort(result: AbortResult): void {
    this.releaseCapture();
    void abortProbe(this.process.child, { keepEventLoopAlive: true }).then((cleanup) =>
      this.resolve({ ...result, error: { ...result.error, ...cleanup } }),
    );
  }

  private releaseCapture(): void {
    clearTimeout(this.timer);
    this.control.off("data", this.onControl);
    this.process.child.stdout.off("data", this.onStdout);
    this.process.child.off("error", this.onError);
    this.process.detach();
    this.capture.release();
  }

  private boundBy(ms: number, timedOut: typeof commandTimedOut): ReturnType<typeof setTimeout> {
    const bound = setTimeout(() => this.abort(timedOut(ms, ...this.capturedOutput())), ms);
    bound.unref?.();
    return bound;
  }
}
