/**
 * A probe script's output capture: two named pipes in a directory made for that probe alone,
 * which its command is `exec`ed into (PRD §9.2, C-PERF-03, C-PERF-05).
 */

import { execFile } from "node:child_process";
import { closeSync, constants, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { shellQuote } from "../shell-quote.ts";
import { CappedBuffer } from "./capped-buffer.ts";
import type { CaptureEvents, ProbeCapture, ProbeChild } from "./capture.ts";
import { makePrivateDirectory, removePrivateDirectory } from "./private-directory.ts";
import { probeOutputRedirect } from "./start.ts";

/**
 * How often a named pipe is read: a nominal cadence, which a busy event loop can stretch.
 * macOS's kqueue reports a named pipe's data but never its end, when the last writer closes
 * it, so the reader polls instead. A full pipe blocks its writer between reads, so the cadence
 * only delays when Elwood sees output, and its end.
 */
const capturePollMs = 25;

/**
 * How much of a pipe one read takes. The cap bounds what Elwood keeps, not what it reads: the
 * read that passes the cap takes up to this much, and the overflow then ends the probe. The
 * writer is held only by what the pipe itself can buffer.
 */
const readChunkBytes = 64 * 1024;

/** The pipes' mode: only Elwood's user can open them, inside a directory only it can enter. */
const pipeMode = "600";

/** The two pipes' names in the probe's directory: the command's stdout, then its stderr. */
const pipeNames = ["stdout", "stderr"] as const;

/** The system's `mkfifo`: Node cannot make a named pipe itself. */
const systemMkfifo = "/usr/bin/mkfifo";
let mkfifo = systemMkfifo;

/** Points the capture at another `mkfifo`, so a test can make one fail; with none, the system's. */
export function setMkfifoForTests(path: string = systemMkfifo): void {
  mkfifo = path;
}

const run = promisify(execFile);

/** A named pipe's read end, and a write end that keeps it open until the command has its own. */
class NamedPipe {
  readonly buffer = new CappedBuffer();
  private readonly scratch = Buffer.alloc(readChunkBytes);
  private reader: number | undefined;
  private holder: number | undefined;
  closed = false;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  open(): void {
    // Without a writer a pipe reads as ended, so Elwood holds one of its own until the probe
    // exits; the command's `exec` then opens its write end without waiting.
    this.reader = openSync(this.path, constants.O_RDONLY | constants.O_NONBLOCK);
    this.holder = openSync(this.path, constants.O_WRONLY | constants.O_NONBLOCK);
  }

  /** Lets the pipe end when every other writer has closed it. */
  letEnd(): void {
    if (this.holder !== undefined) closeSync(this.holder);
    this.holder = undefined;
  }

  /** Reads what is waiting, until it is drained, ends, or passes the cap. */
  read(): void {
    while (!(this.closed || this.buffer.overflowed) && this.reader !== undefined) {
      let length: number;
      try {
        length = readSync(this.reader, this.scratch, 0, this.scratch.length, null);
      } catch {
        // `EAGAIN`: a writer remains, but nothing is waiting. A pipe's read fails no other
        // way, and if one did, the command's bound would still end the probe.
        return;
      }
      if (length === 0) this.closed = true;
      else this.buffer.append(Buffer.from(this.scratch.subarray(0, length)));
    }
  }

  release(): void {
    this.letEnd();
    if (this.reader !== undefined) closeSync(this.reader);
    this.reader = undefined;
    this.buffer.release();
  }
}

/**
 * Two named pipes in a directory made for one probe, mode 0700, removed on release. They read
 * as an ordinary pipe does: anything the command starts that keeps its output open keeps the
 * probe open, a full pipe blocks its writer, and once Elwood's read ends close, a writer that
 * remains is stopped by `SIGPIPE` when it next writes; one that stays silent lives on, as it
 * would on an ordinary pipe. Node has no `mkfifo`, so the system's makes them.
 */
export class NamedPipeCapture implements ProbeCapture {
  private readonly dir: string;
  private readonly pipes: readonly [NamedPipe, NamedPipe];
  private poll: ReturnType<typeof setInterval> | undefined;

  private constructor(dir: string) {
    this.dir = dir;
    const [stdout, stderr] = pipeNames;
    this.pipes = [new NamedPipe(join(dir, stdout)), new NamedPipe(join(dir, stderr))];
  }

  /** The probe's arguments, its script's output placeholder replaced by the pipes' quoted paths. */
  args(args: readonly string[]): readonly string[] {
    const [stdout, stderr] = this.pipes.map((pipe) => shellQuote(pipe.path));
    const redirect = `>${stdout} 2>${stderr}`;
    const script = args.length - 1;
    return args.map((arg, index) =>
      index === script ? arg.slice(0, -probeOutputRedirect.length) + redirect : arg,
    );
  }

  static async create(): Promise<NamedPipeCapture> {
    const capture = new NamedPipeCapture(makePrivateDirectory());
    try {
      await run(mkfifo, ["-m", pipeMode, ...capture.pipes.map((pipe) => pipe.path)]);
      for (const pipe of capture.pipes) pipe.open();
      return capture;
    } catch (error) {
      capture.release();
      throw error;
    }
  }

  watch(child: ProbeChild, events: CaptureEvents): void {
    child.stdout.resume(); // read for the start line only, by the runner
    child.stderr.resume();
    const read = () => this.read(events);
    child.once("exit", () => {
      for (const pipe of this.pipes) pipe.letEnd();
      read();
    });
    // Referenced, unlike the probe's bounds: once the command has exited, a process it started
    // that still holds a pipe keeps the probe pending, and only this keeps the host alive to
    // deliver its result. Release clears it however the probe settles.
    this.poll = setInterval(read, capturePollMs);
  }

  private read(events: CaptureEvents): void {
    for (const pipe of this.pipes) pipe.read();
    if (this.pipes.some((pipe) => pipe.buffer.overflowed)) events.overflowed();
    else if (this.ended()) events.ended();
  }

  ended(): boolean {
    return this.pipes.every((pipe) => pipe.closed);
  }

  text(): [string, string] {
    return [this.pipes[0].buffer.text(), this.pipes[1].buffer.text()];
  }

  release(): void {
    clearInterval(this.poll);
    for (const pipe of this.pipes) pipe.release();
    removePrivateDirectory(this.dir, pipeNames);
  }
}
