/**
 * Bounded one-shot subprocess probe used by the command-runner seam.
 * Implements PRD §9.2 bounded probe runtime/output (C-PERF-01, C-PERF-03): a
 * misbehaving CLI on PATH must not hang or flood memory during a `--version`,
 * `update`, or `--help` probe.
 */

import { spawn } from "node:child_process";
import type { CommandResult } from "./seams.ts";

const defaultProbeTimeoutMs = 15_000;
const maxProbeOutputBytes = 1_000_000;
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
    const remaining = maxProbeOutputBytes - this.byteLength;
    if (remaining <= 0) {
      this.overflowed = true;
      return;
    }
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
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export function runProbe(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args]);
    const out = new CappedBuffer();
    const err = new CappedBuffer();
    let settled = false;
    // Kill only when WE abort the probe (timeout/overflow); a normal exit or
    // spawn failure needs no signal (C-PERF-03, review-security).
    const settle = (result: CommandResult, kill = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) child.kill("SIGKILL");
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
    child.on("close", (code) => {
      settle({ status: code, stdout: out.text(), stderr: err.text() });
    });
    const timer = setTimeout(() => {
      settle(timedOut(out.text(), err.text()), true);
    }, probeTimeoutMs);
    timer.unref?.();
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

function overflow(stdout: string, stderr: string): CommandResult {
  const message = `probe output exceeded ${maxProbeOutputBytes} bytes`;
  return { status: null, stdout, stderr, error: { code: "E2BIG", message } };
}
