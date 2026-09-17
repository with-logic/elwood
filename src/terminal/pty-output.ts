/**
 * Coalesces adjacent PTY chunks into bounded render batches.
 * Implements PRD §4.1 and C-PERF-06.
 */

import { Buffer } from "node:buffer";

export const renderBatchBytes = 64 * 1024;
export const renderBatchDelayMs = 4;
// A UTF-16 code unit occupies at most three UTF-8 bytes. Slicing at 16K units
// leaves room for whole surrogate pairs while keeping every piece below 64 KiB.
const pieceCodeUnits = renderBatchBytes / 4;

export class PtyOutput {
  private readonly write: (data: string) => Promise<void>;
  private chunks: string[] = [];
  private bufferedBytes = 0;
  private scheduled: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(write: (data: string) => Promise<void>) {
    this.write = write;
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
    this.chunks = [];
    this.bufferedBytes = 0;
    // Rendering and public observer failures have no caller on the PTY path.
    void this.write(data).catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.scheduled);
    this.scheduled = undefined;
    this.chunks = [];
    this.bufferedBytes = 0;
  }
}
