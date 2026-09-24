/**
 * Live-only startup replay for terminal data and pre-return attention.
 * Implements PRD §5.3, §8.3, and C-CLI-05. The buffer is bounded in BYTES (128 KB
 * default) but trims on a UTF-8 code-point boundary, so a replayed `terminal:data`
 * never opens with a split multibyte sequence decoded as U+FFFD.
 */

import type { ElwoodActivityEvent } from "./activity/index.ts";

type TerminalDataEvent = {
  readonly elwoodSessionId: string;
  readonly data: string;
};

export class TerminalReplayBuffer {
  private readonly elwoodSessionId: string;
  private readonly maxBytes: number;
  private readonly chunks: string[] = [];
  private size = 0;
  private readonly startupAttention: ElwoodActivityEvent[] = [];
  private stopAttentionCapture: (() => void) | undefined;

  constructor(elwoodSessionId: string, maxBytes = 128_000) {
    this.elwoodSessionId = elwoodSessionId;
    this.maxBytes = maxBytes;
  }

  push(data: string): void {
    this.chunks.push(data);
    this.size += Buffer.byteLength(data);
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      // The loop guard keeps the buffer non-empty, so shift always yields a chunk.
      this.size -= Buffer.byteLength(this.chunks.shift()!);
    }
    if (this.size > this.maxBytes && this.chunks[0] !== undefined) {
      this.chunks[0] = trimToCodePoint(Buffer.from(this.chunks[0]), this.maxBytes);
      this.size = Buffer.byteLength(this.chunks[0]);
    }
  }

  replayFor(event: string, handler: (event: never) => unknown): void {
    if (event === "terminal:data") this.replay(handler as (event: TerminalDataEvent) => unknown);
    if (event === "activity")
      this.replayAttention(handler as (event: ElwoodActivityEvent) => unknown);
  }

  replay(handler: (event: TerminalDataEvent) => unknown): void {
    if (this.chunks.length === 0) return;
    handler({ elwoodSessionId: this.elwoodSessionId, data: this.chunks.join("") });
  }

  /** Capture stable attention activities until the eager start promise has returned. */
  captureStartupAttention(source: {
    on(event: "activity", handler: (event: ElwoodActivityEvent) => void): () => void;
  }): void {
    this.stopAttentionCapture = source.on("activity", (event) => {
      if (event.kind === "attention") this.startupAttention.push(event);
    });
  }

  /** Replay pre-return attention to a synchronously attached lazy-facade subscriber. */
  replayAttention(handler: (event: ElwoodActivityEvent) => unknown): void {
    for (const event of this.startupAttention) handler(event);
  }

  /** End the narrow replay window on a macrotask after the start promise resolves. */
  releaseStartupAttentionAfterReturn(): void {
    const timer = setTimeout(() => {
      this.stopAttentionCapture?.();
      this.stopAttentionCapture = undefined;
      this.startupAttention.length = 0;
    }, 0);
    timer.unref?.();
  }
}

/**
 * The last at-most-`maxBytes` bytes of `bytes`, decoded from a code-point boundary: a cut that
 * lands inside a multibyte sequence skips its leading continuation bytes (0b10xxxxxx) so the
 * kept tail is never shorter than the bound by more than one code point and never starts with
 * U+FFFD.
 */
function trimToCodePoint(bytes: Buffer, maxBytes: number): string {
  let start = bytes.length - maxBytes;
  while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
