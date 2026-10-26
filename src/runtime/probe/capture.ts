/**
 * Where a probe's output is captured, bounded by a per-stream byte cap (PRD §9.2, C-PERF-03,
 * C-PERF-05). A directly spawned command owns its stdout and stderr pipes, so they are captured
 * as they arrive. A login shell's pipes are shared with everything its startup files run. A
 * DEBUG or ZERR trap writes to them while the command runs, an EXIT trap and `.zlogout` write
 * after it, and a background helper can write at any time, so no marker can tell their output
 * from the command's. A probe script therefore `exec`s its command with stdout and stderr
 * redirected into two files in a directory made for that probe alone. Nothing the shell started
 * holds those files, and after `exec` no shell code runs. The shell's own pipes are drained and
 * never kept.
 */

import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { completeUtf8Length } from "../../core/utf8.ts";

/** Each captured stream's byte cap (C-PERF-03). */
export const maxProbeOutputBytes = 1_000_000;

/** The environment variable that names a probe script's private output directory. */
export const probeOutputEnv = "ELWOOD_PROBE_OUTPUT";

/** The redirection a probe script gives the command it `exec`s. */
export const probeOutputRedirect = `>"$${probeOutputEnv}/stdout" 2>"$${probeOutputEnv}/stderr"`;

/**
 * How often a file capture compares its files with the cap. A pipe stops being read at the
 * cap, but a file does not stop its writer, so a command can write one interval's worth past
 * the cap, plus any delay in the event loop, before it is killed. At 25 ms and a local disk's
 * roughly 2 GB/s that is about 50 MB, in a private file that is deleted when the probe settles.
 * `ulimit -f` would bound the file exactly, but it would also kill `claude update` and
 * `codex update` while they download.
 */
export const capturePollMs = 25;
let pollMs = capturePollMs;

/** Overrides the poll interval, so a test can let a command exit over the cap unpolled. */
export function setCapturePollForTests(ms: number): void {
  pollMs = ms;
}

/** The probe process's stdout and stderr pipes. */
export type ProbeStreams = { readonly stdout: Readable; readonly stderr: Readable };

/** One probe's output capture. */
export type ProbeCapture = {
  /** The probe process's environment, when it differs from Elwood's own. */
  readonly env: NodeJS.ProcessEnv | undefined;
  /** Captures `child`'s output, calling `overflowed` once a stream passes the cap. */
  watch(child: ProbeStreams, overflowed: () => void): void;
  /** Whether a stream has passed the cap. */
  overflowed(): boolean;
  /** Each stream's capture, stdout then stderr, at most the cap. */
  text(): [string, string];
  /** Drops the capture; a file capture removes its directory. Safe to call twice. */
  release(): void;
};

/**
 * A capture for a probe: private files for a script that announces its command with the
 * start line, which only a probe script does; the pipes for any other command.
 */
export function probeCapture(script: boolean): ProbeCapture {
  return script ? new FileCapture() : new PipeCapture();
}

/** Decodes captured bytes, dropping a code point the cap split (C-PERF-03). */
function decode(bytes: Buffer): string {
  return bytes.subarray(0, completeUtf8Length(bytes)).toString("utf8");
}

/** Accumulates stream chunks up to the cap, tracking overflow. */
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
    return decode(Buffer.concat(this.chunks));
  }

  release(): void {
    this.chunks = [];
  }
}

/** A directly spawned command's own stdout and stderr pipes. */
class PipeCapture implements ProbeCapture {
  readonly env = undefined;
  private readonly out = new CappedBuffer();
  private readonly err = new CappedBuffer();

  watch(child: ProbeStreams, overflowed: () => void): void {
    const onData = (buffer: CappedBuffer) => (chunk: Buffer) => {
      buffer.append(chunk);
      if (this.overflowed()) overflowed();
    };
    child.stdout.on("data", onData(this.out));
    child.stderr.on("data", onData(this.err));
  }

  overflowed(): boolean {
    return this.out.overflowed || this.err.overflowed;
  }

  text(): [string, string] {
    return [this.out.text(), this.err.text()];
  }

  release(): void {
    // An unresolved probe's reaper retains the child and its listeners, and through them
    // these chunks, so they are dropped here rather than left for the reaper to outlive.
    this.out.release();
    this.err.release();
  }
}

/** The private files a probe script's command writes; mode 0700, removed on release. */
class FileCapture implements ProbeCapture {
  private readonly dir = mkdtempSync(join(tmpdir(), "elwood-probe-"));
  private readonly files = [join(this.dir, "stdout"), join(this.dir, "stderr")] as const;
  private poll: ReturnType<typeof setInterval> | undefined;
  readonly env = { ...process.env, [probeOutputEnv]: this.dir };

  watch(child: ProbeStreams, overflowed: () => void): void {
    child.stderr.resume(); // the shell's own; stdout is read for the start line
    this.poll = setInterval(() => this.overflowed() && overflowed(), pollMs);
    this.poll.unref();
  }

  overflowed(): boolean {
    return this.files.some((file) => fileSize(file) > maxProbeOutputBytes);
  }

  text(): [string, string] {
    return [readCapped(this.files[0]), readCapped(this.files[1])];
  }

  release(): void {
    clearInterval(this.poll);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A file's size; 0 when the command never created it. */
function fileSize(file: string): number {
  return statSync(file, { throwIfNoEntry: false })?.size ?? 0;
}

/** Up to the cap's worth of a file's leading bytes, decoded. */
function readCapped(file: string): string {
  const size = Math.min(fileSize(file), maxProbeOutputBytes);
  if (size === 0) return "";
  const fd = openSync(file, "r");
  try {
    const bytes = Buffer.alloc(size);
    return decode(bytes.subarray(0, readSync(fd, bytes, 0, size, 0)));
  } finally {
    closeSync(fd);
  }
}
