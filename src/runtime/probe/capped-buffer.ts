/**
 * A probe's captured stream, bounded by the per-stream byte cap. Implements the output bound of
 * PRD §9.2 (C-PERF-03): a CLI that floods its output cannot flood Elwood's memory.
 */

import { completeUtf8Length } from "../../core/utf8.ts";

/** Each captured stream's own byte cap, not the probe's total (C-PERF-03). */
export const maxProbeStreamOutputBytes = 1_000_000;

/** Accumulates stream chunks up to a hard byte cap, tracking overflow. */
export class CappedBuffer {
  private chunks: Buffer[] = [];
  private byteLength = 0;
  overflowed = false;

  append(chunk: Buffer): void {
    // Once the cap is hit the probe is aborted and its pipes destroyed, so no chunk
    // ever arrives after `overflowed` is set; the first over-cap chunk is the last.
    const remaining = maxProbeStreamOutputBytes - this.byteLength;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.byteLength = maxProbeStreamOutputBytes;
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
