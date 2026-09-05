/**
 * Ordered JSON-lines renderer with a single terminal-record latch.
 * Implements PRD §12A.3 and C-CLI-11.
 */

import type { AsyncOutputSink } from "../stream.ts";
import type { CliJsonlRecord, CliProgressRecord, CliTerminalRecord } from "./types.ts";

export class JsonlRenderer {
  private readonly sink: AsyncOutputSink;
  private sequence = 0;
  private terminal = false;

  constructor(sink: AsyncOutputSink) {
    this.sink = sink;
  }

  progress(record: CliProgressRecord): Promise<boolean> {
    if (this.terminal || this.sink.closed) return Promise.resolve(false);
    return this.write({ ...record, sequence: ++this.sequence });
  }

  finish(record: CliTerminalRecord): Promise<boolean> {
    if (this.terminal || this.sink.closed) return Promise.resolve(false);
    this.terminal = true;
    return this.write({ ...record, sequence: ++this.sequence });
  }

  private write(record: CliJsonlRecord): Promise<boolean> {
    return this.sink.write(`${JSON.stringify(record)}\n`);
  }
}
