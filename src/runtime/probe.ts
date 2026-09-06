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
    // Byte capping can split a multibyte code point at the boundary. Drop any
    // incomplete trailing UTF-8 sequence so the decoded string re-encodes to
    // at most the byte cap (C-PERF-03) rather than growing via a replacement
    // character.
    const bytes = Buffer.concat(this.chunks);
    return bytes.subarray(0, completeUtf8Length(bytes)).toString("utf8");
  }
}

/**
 * Returns the length of the longest prefix of `bytes` that ends on a complete
 * UTF-8 code point, dropping at most a 3-byte incomplete trailing sequence.
 * Exported for focused boundary tests (C-PERF-03).
 */
export function completeUtf8Length(bytes: Buffer): number {
  const end = bytes.length;
  // Scan back over continuation bytes (0b10xxxxxx) to the lead byte.
  let lead = end - 1;
  while (lead >= 0 && (bytes[lead] as number) >= 0x80 && (bytes[lead] as number) < 0xc0) lead--;
  if (lead < 0) return end;
  const leadByte = bytes[lead] as number;
  // ASCII byte is itself complete.
  if (leadByte < 0x80) return end;
  // The scan stopped on a lead byte (>= 0xc0), so it heads a 2-, 3-, or 4-byte
  // sequence. Keep all if that sequence is complete; else drop the partial lead.
  const expected = leadByte >= 0xf0 ? 4 : leadByte >= 0xe0 ? 3 : 2;
  return end - lead === expected ? end : lead;
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
