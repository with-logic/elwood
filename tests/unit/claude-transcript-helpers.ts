/**
 * Shared fixture helpers for the Claude transcript watcher/cursor unit tests
 * (PRD §5.4, C-CLAUDE-15): temp transcript paths, JSONL record builders, a typed
 * activity-emitter fake, and a cursor drain. Every claude-transcript-*.test.ts
 * imports from here instead of re-declaring its own copy.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptActivityEmitter } from "../../src/claude/session/transcript.ts";
import type { TranscriptCursor } from "../../src/claude/transcript/cursor.ts";
import type { ClaudeTranscriptEvent } from "../../src/claude/transcript/index.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";

/** A fresh transcript path in its own temp directory (the file is NOT created). */
export function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "elwood-tx-")), "t.jsonl");
}

/** A minimal Claude assistant transcript record carrying one text block. */
export const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

/** Overwrite `path` with the given records as JSONL (an empty file for none). */
export const writeRecords = (path: string, ...records: unknown[]) =>
  writeFileSync(
    path,
    records.length ? `${records.map((r) => JSON.stringify(r)).join("\n")}\n` : "",
  );

/** Grow `path` by rewriting the prior records plus the new ones (never truncates). */
export const appendRecords = (path: string, prior: unknown[], ...records: unknown[]) =>
  writeRecords(path, ...prior, ...records);

/** Assistant text per event (or the summary kind for non-assistant events). */
export const texts = (events: ClaudeTranscriptEvent[]) =>
  events.map((e) => (e.summary.kind === "assistant_message" ? e.summary.text : e.summary.kind));

/** A typed activity-emitter fake that forwards each payload to `sink`. */
export function fakeEmitter(
  sink: (event: ElwoodActivityEvent) => void = () => {},
): TranscriptActivityEmitter {
  return { emit: (_event, payload) => sink(payload) };
}

/** Drain a cursor to the end, returning the concatenated decoded text. */
export function drainAll(cursor: TranscriptCursor): string {
  let out = "";
  for (let budget = 1000; budget > 0; budget--) {
    const { text, canContinueNow } = cursor.readChunk();
    out += text;
    if (!canContinueNow) break;
  }
  return out;
}

/** An `EISDIR`-coded error, as thrown when a transcript path becomes a directory. */
export function eisdirError(): Error {
  return Object.assign(new Error("EISDIR: illegal operation on a directory"), {
    code: "EISDIR",
  });
}
