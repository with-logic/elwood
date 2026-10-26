/**
 * Finds one marker in a byte stream whose chunks may split it anywhere. Shared by the probe
 * shell's start line (PRD §9.2, C-PERF-05) and the e2e home guard's stop marker (PRD §12,
 * C-E2E-24), so both read a split marker the same way.
 */

export class StreamMarker {
  private readonly marker: Buffer;
  private tail = Buffer.alloc(0);
  private found = false;

  constructor(marker: Buffer) {
    this.marker = marker;
  }

  /** Whether the stream has carried the marker. */
  get seen(): boolean {
    return this.found;
  }

  /** True exactly once: for the chunk that completes the marker. */
  feed(chunk: Buffer): boolean {
    if (this.found) return false;
    const window = Buffer.concat([this.tail, chunk]);
    if (window.includes(this.marker)) {
      this.found = true;
      this.tail = Buffer.alloc(0);
      return true;
    }
    // Keep a copy of only what could still begin a split marker: a view would pin the whole
    // chunk for as long as the watcher lives, as an unresolved probe's reaper retains it.
    const keep = this.marker.length - 1;
    this.tail = Buffer.from(window.subarray(Math.max(0, window.length - keep)));
    return false;
  }
}
