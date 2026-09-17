/**
 * Bounded one-shot subprocess probe used by the command-runner seam.
 * Implements PRD §9.2 bounded probe runtime/output (C-PERF-01, C-PERF-03, C-PERF-05): a
 * misbehaving CLI on PATH must not hang or flood memory during a `--version`,
 * `update`, or `--help` probe.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { completeUtf8Length } from "../core/utf8.ts";
import type { CommandResult } from "./seams.ts";
import { rethrowUnlessGroupGone } from "./shutdown/reap-tree.ts";

const defaultProbeTimeoutMs = 15_000;
const maxProbeOutputBytes = 1_000_000;
const exitDrainMs = 250;
let probeTimeoutMs = defaultProbeTimeoutMs;

export function setProbeTimeoutMsForTests(value: number): void {
  probeTimeoutMs = value;
}

export function resetProbeTimeoutForTests(): void {
  probeTimeoutMs = defaultProbeTimeoutMs;
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
}

export function runProbe(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    // Probe shells are interactive so they load the same user PATH as the PTY launch. Give
    // them a fresh session: an interactive shell otherwise enables job control on Elwood's
    // controlling terminal and can leave its short-lived command's process group in the
    // foreground, causing headed cleanup to stop on SIGTTOU before restoring terminal modes.
    const child = spawn(command, [...args], { detached: true });
    const out = new CappedBuffer();
    const err = new CappedBuffer();
    let settled = false;
    // Kill only when WE abort the probe (timeout/overflow); a normal exit or
    // spawn failure needs no signal (C-PERF-03).
    const settle = (result: CommandResult, kill = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) abortProbe(child);
      resolve(result);
    };
    const onData = (buffer: CappedBuffer) => (chunk: Buffer) => {
      buffer.append(chunk);
      if (out.overflowed || err.overflowed) settle(overflow(out.text(), err.text()), true);
    };
    child.stdout.on("data", onData(out));
    child.stderr.on("data", onData(err));
    // Spawn failure (e.g. ENOENT) fires `error` and not `close`. Node's spawn
    // `error` always carries a `code`, which preflight maps to `*_not_found`.
    child.on("error", (e: NodeJS.ErrnoException) => {
      settle({ status: null, stdout: out.text(), stderr: err.text(), error: mapError(e) });
    });
    let drain: ReturnType<typeof setTimeout> | undefined;
    let drainTurn: ReturnType<typeof setImmediate> | undefined;
    child.on("close", (code) => {
      clearTimeout(drain);
      clearImmediate(drainTurn);
      settle({ status: code, stdout: out.text(), stderr: err.text() });
    });
    // The direct child's exit completes the probe (C-PERF-05). `close` also waits for every
    // holder of the stdio pipes, and a descendant can inherit them and outlive the child,
    // so output the child already wrote gets one bounded drain and `close` stops deciding.
    child.on("exit", (code) => {
      clearTimeout(timer);
      // The extra loop turn lets a poll phase deliver bytes already in the pipes (and any
      // `close`) even when a stalled host loop reaches this timer after the bound.
      drain = setTimeout(() => {
        drainTurn = setImmediate(() => {
          settle({ status: code, stdout: out.text(), stderr: err.text() });
          releaseInheritedPipes([child.stdout as ProbePipe, child.stderr as ProbePipe]);
        });
      }, exitDrainMs);
      drain.unref();
    });
    const timer = setTimeout(() => {
      settle(timedOut(out.text(), err.text()), true);
    }, probeTimeoutMs);
    timer.unref?.();
  });
}

/**
 * Aborts a probe Elwood gave up on. `detached: true` made the shell its own
 * process-group leader, so SIGKILLing the GROUP (not just the shell pid) also
 * reaches grandchildren such as an installer spawned under `claude update` via
 * `zsh -l -i -c`; a survivor would otherwise inherit the stdio pipes, keep them
 * open, and pin the host event loop long after the probe "timed out". The pipes
 * are destroyed here for the same reason: nothing a killed probe still writes is
 * wanted, and an open pipe alone keeps the loop alive.
 */
function abortProbe(child: ChildProcess): void {
  try {
    // A spawn failure settles via `error` on the next tick, before any timer or
    // data can request a kill, so a killed child always has a pid.
    process.kill(-(child.pid as number), "SIGKILL");
  } catch (error) {
    rethrowUnlessGroupGone(error);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function mapError(error: NodeJS.ErrnoException): {
  readonly code?: string | undefined;
  readonly message: string;
} {
  return { code: error.code, message: error.message };
}

function timedOut(stdout: string, stderr: string): CommandResult {
  const message = `probe timed out after ${probeTimeoutMs} ms`;
  return { status: null, stdout, stderr, error: { code: "ETIMEDOUT", message } };
}

function overflow(stdout: string, stderr: string): CommandResult {
  const message = `probe output exceeded ${maxProbeOutputBytes} bytes`;
  return { status: null, stdout, stderr, error: { code: "E2BIG", message } };
}

/** A spawned child's stdio pipe is a socket; the `Readable` typing of `child.stdout` hides `unref`. */
type ProbePipe = import("node:net").Socket;

/**
 * Stops capturing from pipes a descendant still holds without closing them: a closed
 * read end would fail the descendant's next write (normal completion never signals the
 * group), while a referenced one would keep the host event loop alive.
 */
function releaseInheritedPipes(pipes: readonly ProbePipe[]): void {
  for (const pipe of pipes) {
    pipe.removeAllListeners("data");
    pipe.resume();
    pipe.unref();
  }
}
