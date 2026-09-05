/**
 * Exact final and incremental text rendering for shell-friendly CLI output.
 * Implements PRD §12A.3 and C-CLI-10.
 */

import type { AsyncOutputSink } from "../stream.ts";

export function writeFinalText(sink: AsyncOutputSink, response: string): Promise<boolean> {
  if (response.length === 0) return Promise.resolve(!sink.closed);
  return sink.write(`${response}\n`);
}

export class StreamingTextRenderer {
  private readonly sink: AsyncOutputSink;
  private messages = 0;
  private wrote = false;

  constructor(sink: AsyncOutputSink) {
    this.sink = sink;
  }

  message(text: string): Promise<boolean> {
    if (text.length === 0) return Promise.resolve(!this.sink.closed);
    const separator = this.messages === 0 ? "" : "\n\n";
    this.messages += 1;
    this.wrote = true;
    return this.sink.write(`${separator}${text}`);
  }

  finish(): Promise<boolean> {
    return this.wrote ? this.sink.write("\n") : Promise.resolve(!this.sink.closed);
  }
}
