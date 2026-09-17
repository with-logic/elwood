/**
 * Coalesces adjacent PTY chunks and, when the adapter supplies `flowControl`,
 * bounds the pending rendering backlog with backpressure. Adapters without flow
 * control still batch, but their backlog is unbounded.
 * Implements PRD §4.1 and C-PERF-06.
 */

import { Buffer } from "node:buffer";
import type { PtyProcess } from "../pty/types.ts";

export const renderHighWaterBytes = 1024 * 1024;
export const renderLowWaterBytes = renderHighWaterBytes / 2;
export const renderBatchBytes = 64 * 1024;
export const renderBatchDelayMs = 4;
// A UTF-16 code unit occupies at most three UTF-8 bytes. Slicing at 16K units
// leaves room for whole surrogate pairs while keeping every piece below 64 KiB.
const pieceCodeUnits = renderBatchBytes / 4;

export class PtyOutput {
  private readonly write: (data: string) => Promise<void>;
  private readonly flow: PtyProcess["flowControl"];
  private paused: PtyProcess["flowControl"];
  private chunks: string[] = [];
  private bufferedBytes = 0;
  private pendingBytes = 0;
  private scheduled: NodeJS.Timeout | undefined;
  private disposed = false;
  /** Cleared at child exit: a pause after that could never be lifted by a producer. */
  private throttled = true;

  constructor(write: (data: string) => Promise<void>, flow: PtyProcess["flowControl"]) {
    this.write = write;
    this.flow = flow;
  }

  push(data: string): void {
    if (this.disposed) return;
    for (let start = 0; start < data.length; ) {
      let end = Math.min(start + pieceCodeUnits, data.length);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
      const chunk = data.slice(start, end);
      const bytes = Buffer.byteLength(chunk);
      if (this.bufferedBytes + bytes > renderBatchBytes) this.flush();
      this.chunks.push(chunk);
      this.bufferedBytes += bytes;
      this.pendingBytes += bytes;
      if (
        this.throttled &&
        !this.paused &&
        this.pendingBytes >= renderHighWaterBytes &&
        this.flow
      ) {
        this.paused = this.flow;
        this.paused.pause();
      }
      if (this.bufferedBytes === renderBatchBytes) this.flush();
      start = end;
    }
    if (this.bufferedBytes > 0 && !this.scheduled) {
      this.scheduled = setTimeout(() => this.flush(), renderBatchDelayMs);
    }
  }

  flush(): void {
    clearTimeout(this.scheduled);
    this.scheduled = undefined;
    if (this.bufferedBytes === 0) return;
    const data = this.chunks.join("");
    const bytes = this.bufferedBytes;
    this.chunks = [];
    this.bufferedBytes = 0;
    // Rendering and public observer failures have no caller on the PTY path.
    // Own both outcomes, and always release their byte reservation.
    void this.write(data).then(
      () => this.release(bytes),
      () => this.release(bytes),
    );
  }

  /**
   * Stop throttling reads and stay unpaused. Used at child exit, where the producer
   * is gone: further accounting could only re-pause a PTY nobody will resume.
   */
  releaseFlowControl(): void {
    this.throttled = false;
    this.resume();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.scheduled);
    this.scheduled = undefined;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.pendingBytes = 0;
    this.resume();
  }

  private release(bytes: number): void {
    if (this.disposed) return;
    this.pendingBytes -= bytes;
    if (this.pendingBytes < renderLowWaterBytes) this.resume();
  }

  private resume(): void {
    if (!this.paused) return;
    const flow = this.paused;
    this.paused = undefined;
    flow.resume();
  }
}
