/**
 * Live-only terminal replay buffer for late subscribers.
 * Implements PRD §5.3 and §8.3.
 */

type TerminalDataEvent = {
  readonly elwoodSessionId: string;
  readonly data: string;
};

export class TerminalReplayBuffer {
  private readonly elwoodSessionId: string;
  private readonly maxBytes: number;
  private readonly chunks: string[] = [];
  private size = 0;

  constructor(elwoodSessionId: string, maxBytes = 128_000) {
    this.elwoodSessionId = elwoodSessionId;
    this.maxBytes = maxBytes;
  }

  push(data: string): void {
    this.chunks.push(data);
    this.size += Buffer.byteLength(data);
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      this.size -= Buffer.byteLength(this.chunks.shift() ?? "");
    }
    if (this.size > this.maxBytes && this.chunks[0] !== undefined) {
      this.chunks[0] = Buffer.from(this.chunks[0]).subarray(-this.maxBytes).toString("utf8");
      this.size = Buffer.byteLength(this.chunks[0]);
    }
  }

  replay(handler: (event: TerminalDataEvent) => unknown): void {
    if (this.chunks.length === 0) return;
    handler({ elwoodSessionId: this.elwoodSessionId, data: this.chunks.join("") });
  }
}
