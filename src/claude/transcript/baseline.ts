/**
 * Backward current-turn recovery for the transcript cursor.
 * Implements PRD §5.4 (C-CLAUDE-15): scans BACKWARD from EOF to the last user
 * PROMPT so a Stop-first first-observe replays the whole committed current turn
 * without corrupting a UTF-8 code point at a block seam, without O(n²) window
 * re-splits, and — when the turn is larger than the cap — without silently
 * dropping the whole turn (the in-window committed records are recovered instead).
 */

import { readBackwardBlock } from "./cursor-io.ts";

const stepBytes = 64 * 1024; // one backward step in current-turn recovery
const maxBytes = 4 * 1024 * 1024; // cap on how far back the baseline scan reaches
// Hard record-count budget so a pathological many-tiny-line window cannot run an
// unbounded JSON.parse loop even inside the byte cap (a CPU guard, not a byte one).
const defaultMaxRecords = 200_000;
let maxRecords = defaultMaxRecords;

/** Test seam: shrink the record budget so the CPU guard is exercisable cheaply. */
export function setMaxRecordsForTests(value: number): void {
  maxRecords = value;
}
export function resetMaxRecordsForTests(): void {
  maxRecords = defaultMaxRecords;
}

/**
 * Recovered current turn: the committed record lines plus whether the scan hit
 * its byte/record cap before the user PROMPT boundary. `truncated` is true only
 * on that cap path (NOT on a clean BOF with no boundary, which has no turn to
 * recover); `unrecoveredBytes` is then the magnitude of the earlier-in-file
 * portion that fell outside the window, so the caller can surface it as a bounded,
 * content-free drop rather than silently losing it (MINOR: truncation accounting).
 */
export type BaselineTail = {
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly unrecoveredBytes: number;
};

/**
 * Scans backward in bounded blocks to the last user PROMPT. Blocks are collected
 * newest-first and reversed ONCE at return (no repeated prepend), and only each
 * block's OWN lines are scanned for a boundary (the seam line re-merges with the
 * carried head), so total work stays linear. Returns the current-turn lines and
 * whether the scan stopped at the cap/BOF without finding the boundary.
 */
export function scanBaselineTail(path: string, size: number): BaselineTail {
  if (size === 0) return { lines: [], truncated: false, unrecoveredBytes: 0 };
  const chunks: string[][] = []; // confirmed post-frontier line runs, newest-first
  let head = ""; // partial first line of the block just scanned (seam carry)
  let end = size;
  let records = 0;
  while (size - end < maxBytes && records < maxRecords) {
    const start = Math.max(0, end - stepBytes);
    const block = readBackwardBlock(path, start, end);
    const lines = block.text.split(/\r?\n/);
    lines[lines.length - 1] += head; // re-merge the seam-split line with the carry
    records += lines.length;
    const boundary = lastUserLine(lines);
    if (boundary >= 0)
      return {
        lines: flatten(chunks, lines.slice(boundary + 1)),
        truncated: false,
        unrecoveredBytes: 0,
      };
    // Reached the start of the file with NO prompt: the file holds no boundary at
    // all, so there is no current turn to recover — matches the pre-fix contract.
    if (block.start === 0) return { lines: [], truncated: false, unrecoveredBytes: 0 };
    head = lines[0] as string; // carry the (still partial) first line one step back
    chunks.push(lines.slice(1));
    end = block.start;
  }
  // Cap/record-budget hit BEFORE the boundary (the turn is larger than the cap):
  // recover the in-window bounded records rather than discarding the whole turn.
  // The carried `head` is a partial first line (the window began mid-file), so it
  // is dropped, not emitted; every complete in-window record is kept. `end` is the
  // byte offset the recovered window begins at, so the `[0, end)` prefix is the
  // magnitude of the earlier-in-file portion that was NOT recovered.
  return { lines: flatten(chunks, []), truncated: true, unrecoveredBytes: end };
}

// Assemble the turn in FORWARD (oldest-first) order. `tail` is the post-boundary
// run of the deepest block (oldest lines); `chunks` were pushed newest-first, so
// they are walked in reverse to append oldest→newest. Flattened exactly once.
function flatten(chunks: readonly string[][], tail: readonly string[]): string[] {
  const out: string[] = [...tail];
  for (let i = chunks.length - 1; i >= 0; i--) out.push(...(chunks[i] as string[]));
  return out;
}

/** Index of the last `user`-role PROMPT line in `lines`, or -1 if none. */
function lastUserLine(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isUserRecord(lines[i] as string)) return i;
  }
  return -1;
}

// True only for a genuine user PROMPT — the real turn boundary. A `tool_result`
// is ALSO a `type:"user"` record but belongs to the current turn, so it is NOT a
// boundary (else committed tool activity is dropped). A prompt carries prose
// (string content or a `text` block); a pure tool_result carries only those.
// A cheap prefilter skips JSON.parse for any line that cannot be a user record.
function isUserRecord(line: string): boolean {
  if (!line.includes('"user"')) return false; // prefilter: no user marker → not a boundary
  try {
    const record = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } };
    if (record.type !== "user") return false;
    const content = record.message?.content;
    if (typeof content === "string") return true; // string content is always prose
    if (!Array.isArray(content)) return false;
    // A prompt has at least one non-tool_result block; a pure tool_result record
    // (every block is a tool_result) is part of the current turn, not a boundary.
    return content.some((block) => (block as { type?: unknown })?.type !== "tool_result");
  } catch {
    return false;
  }
}
