/**
 * Ordered JSON-lines renderer with a single terminal-record latch.
 * Implements PRD §12A.3 and C-CLI-11.
 */

import type { AsyncOutputSink } from "../stream.ts";
import type { CliJsonlRecord, CliProgressRecord, CliTerminalRecord } from "./types.ts";

export class JsonlRenderer {
  private readonly sink: AsyncOutputSink;
  private readonly elapsedMs: () => number;
  private sequence = 0;
  private terminal = false;

  constructor(sink: AsyncOutputSink, elapsedMs: () => number) {
    this.sink = sink;
    this.elapsedMs = elapsedMs;
  }

  progress(record: CliProgressRecord): Promise<boolean> {
    if (this.terminal || this.sink.closed) return Promise.resolve(false);
    return this.write({ ...record, sequence: ++this.sequence, elapsedMs: this.elapsed() });
  }

  finish(record: CliTerminalRecord): Promise<boolean> {
    if (this.terminal || this.sink.closed) return Promise.resolve(false);
    this.terminal = true;
    return this.write({ ...record, sequence: ++this.sequence, elapsedMs: this.elapsed() });
  }

  private write(record: CliJsonlRecord): Promise<boolean> {
    return this.sink.write(`${JSON.stringify(record)}\n`);
  }

  private elapsed(): number {
    return Math.max(0, Math.trunc(this.elapsedMs()));
  }
}
