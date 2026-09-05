/**
 * One-document JSON renderer for canonical terminal CLI records.
 * Implements PRD §12A.3 and C-CLI-11.
 */

import type { AsyncOutputSink } from "../stream.ts";
import type { CliTerminalRecord } from "./types.ts";

export function writeJson(sink: AsyncOutputSink, record: CliTerminalRecord): Promise<boolean> {
  return sink.write(`${JSON.stringify(record)}\n`);
}
