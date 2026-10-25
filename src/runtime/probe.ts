/**
 * Bounded one-shot subprocess probe used by the command-runner seam.
 * Implements PRD §9.2 bounded probe runtime/output (C-PERF-01, C-PERF-03, C-PERF-05):
 * a misbehaving CLI on PATH must not hang or flood memory during a `--version`,
 * `update`, or `--help` probe, and a slow login-shell profile is bounded separately
 * from the CLI it launches.
 */

import { spawn } from "node:child_process";
import { completeUtf8Length } from "../core/utf8.ts";
import { abortProbe } from "./probe-cleanup.ts";
import { ProbeStartWatcher, withoutStartLine } from "./probe-start.ts";
import type { CommandResult } from "./seams.ts";

// The probe command's own bound, from the shell's start line (C-PERF-03).
const defaultProbeTimeoutMs = 15_000;
// The login shell's bound, from spawn to its start line (C-PERF-05). Loading the
// user's interactive profile took 9-19 s at 16 concurrent probes on a loaded host.
const defaultLaunchTimeoutMs = 60_000;
const maxProbeOutputBytes = 1_000_000;
let probeTimeoutMs = defaultProbeTimeoutMs;
let launchTimeoutMs = defaultLaunchTimeoutMs;

/** Direct (non-shell) test commands never write the start line, so both bounds default together. */
export function setProbeTimeoutMsForTests(value: number, launchValue = value): void {
  probeTimeoutMs = value;
  launchTimeoutMs = launchValue;
}

export function resetProbeTimeoutForTests(): void {
  probeTimeoutMs = defaultProbeTimeoutMs;
  launchTimeoutMs = defaultLaunchTimeoutMs;
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
    const captured = (): [string, string] => [out.text(), withoutStartLine(err.text())];
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
    const start = new ProbeStartWatcher();
    child.stdout.on("data", onData(out));
    child.stderr.on("data", onData(err));
    // The start line ends the login shell's launch phase: the command's own bound begins
    // there, so the user's profile load is never charged to the CLI (C-PERF-05).
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled || !start.feed(chunk)) return;
      clearTimeout(timer);
      timer = boundBy(probeTimeoutMs, () => timedOut(...captured()));
    });
    // Spawn failure (e.g. ENOENT) fires `error` and not `close`. Node's spawn
    // `error` always carries a `code`, which preflight maps to `*_not_found`.
    child.on("error", (e: NodeJS.ErrnoException) => {
      const [stdout, stderr] = captured();
      settle({ status: null, stdout, stderr, error: mapError(e) });
    });
    child.on("close", (code) => {
      const [stdout, stderr] = captured();
      settle({ status: code, stdout, stderr });
    });
    // The launch phase runs from spawn until the shell's start line (C-PERF-05).
    let timer = boundBy(launchTimeoutMs, () => launchTimedOut(...captured()));
  });
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

function launchTimedOut(stdout: string, stderr: string): CommandResult {
  const message = `login shell did not start the probe command within ${launchTimeoutMs} ms`;
  return { status: null, stdout, stderr, error: { code: "ETIMEDOUT", message } };
}

function overflow(stdout: string, stderr: string): CommandResult {
  const message = `probe output exceeded ${maxProbeOutputBytes} bytes`;
  return { status: null, stdout, stderr, error: { code: "E2BIG", message } };
}
