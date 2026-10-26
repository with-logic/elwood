/**
 * Where a probe's output is captured, bounded by the per-stream byte cap (PRD §9.2, C-PERF-03,
 * C-PERF-05). A directly spawned command owns its stdout and stderr pipes, so they are captured
 * as they arrive. A login shell's pipes are shared with everything its startup files run. A
 * DEBUG or ZERR trap writes to them while the command runs, an EXIT trap and `.zlogout` write
 * after it, and a background helper can write at any time, so no marker can tell their output
 * from the command's. A probe script therefore `exec`s its command with stdout and stderr
 * redirected into two named pipes in a directory made for that probe alone (`probeScript`), and
 * the shell's own pipes are drained and never kept.
 */

import type { Readable } from "node:stream";
import { CappedBuffer } from "./capped-buffer.ts";
import { NamedPipeCapture } from "./named-pipes.ts";
import { announcesStart, probeOutputRedirect } from "./start.ts";

/** The probe process: what a capture reads, and the exit after which only its heirs write. */
export type ProbeChild = {
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "exit", listener: () => void): unknown;
};

/** What a capture reports while it reads. */
export type CaptureEvents = {
  /** A stream passed the cap. */
  readonly overflowed: () => void;
  /**
   * Every named pipe has ended after the probe exited: nothing holds its write end. Only named
   * pipes send it. A process's own pipes end before its `close`, so a capture of them is
   * complete by then.
   */
  readonly ended: () => void;
};

/** One probe's output capture. */
export type ProbeCapture = {
  /** The probe's arguments as the capture runs them: a probe script's output pointed at it. */
  args(args: readonly string[]): readonly string[];
  /** Captures `child`'s output. */
  watch(child: ProbeChild, events: CaptureEvents): void;
  /**
   * Whether the capture is complete, once the probe's process has closed. A capture of the
   * process's own pipes always is. Named pipes are complete once nothing holds their write ends,
   * which a process the command started can delay past the `close`.
   */
  ended(): boolean;
  /** Each stream's capture, stdout then stderr, at most the cap. */
  text(): [string, string];
  /**
   * Drops the capture, closes what it opened, and removes it. Named pipes' directory is removed
   * at once, unless the command changed it: then the removal runs off the event loop and can
   * finish after this returns. Safe to call twice.
   */
  release(): void;
};

/**
 * The capture for a probe: named pipes for a script that `exec`s its command into them,
 * nothing for a script answered by its status alone, and the pipes of any other command.
 */
export function probeCapture(args: readonly string[]): Promise<ProbeCapture> {
  if (args.at(-1)?.endsWith(probeOutputRedirect)) return NamedPipeCapture.create();
  return Promise.resolve(announcesStart(args) ? new DiscardedCapture() : new PipeCapture());
}

/** A directly spawned command's own stdout and stderr pipes. */
class PipeCapture implements ProbeCapture {
  private readonly buffers = [new CappedBuffer(), new CappedBuffer()] as const;

  args(args: readonly string[]): readonly string[] {
    return args;
  }

  watch(child: ProbeChild, events: CaptureEvents): void {
    [child.stdout, child.stderr].forEach((stream, index) => {
      const buffer = this.buffers[index] as CappedBuffer;
      stream.on("data", (chunk: Buffer) => {
        buffer.append(chunk);
        if (buffer.overflowed) events.overflowed();
      });
    });
  }

  ended(): boolean {
    return true; // the process's `close` waits for its pipes
  }

  text(): [string, string] {
    return [this.buffers[0].text(), this.buffers[1].text()];
  }

  release(): void {
    // An unresolved probe's reaper retains the child and its listeners, and through them
    // these chunks, so they are dropped here rather than left for the reaper to outlive.
    for (const buffer of this.buffers) buffer.release();
  }
}

/** A login shell whose command's output went to `/dev/null`: its own pipes are drained. */
class DiscardedCapture implements ProbeCapture {
  args(args: readonly string[]): readonly string[] {
    return args;
  }

  watch(child: ProbeChild): void {
    child.stdout.resume();
    child.stderr.resume();
  }

  ended(): boolean {
    return true;
  }

  text(): [string, string] {
    return ["", ""];
  }

  release(): void {
    // Nothing was kept.
  }
}
