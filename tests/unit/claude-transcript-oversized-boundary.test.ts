/**
 * Regression coverage for the mirrored-discard undercount + per-path marker leak.
 * Covers PRD §5.4 (C-CLAUDE-15): the cursor reports an EXPLICIT discard transition,
 * so two consecutive over-length records split across one chunk boundary count as
 * TWO (not one), and no per-path discard marker survives retire()/finish().
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TranscriptCursor } from "../../src/claude/transcript/cursor.ts";
import type { TranscriptDropNotice } from "../../src/claude/transcript/drops.ts";
import { ClaudeTranscriptWatcher } from "../../src/claude/transcript/index.ts";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "elwood-oversized-")), "t.jsonl");
const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});
const overCap = (fill: string) => fill.repeat(1024 * 1024 + 8); // > the pending cap

describe("C-CLAUDE-15 over-length discard boundary", () => {
  test("Finding A': one chunk that ENDS one over-length record and STARTS the next reports 'started'", () => {
    // The undercount bug at the cursor level: record A's terminating newline is
    // consumed in the SAME call that then buffers a partial record B which itself
    // overflows. The cursor returns `discard: "started"` (not "ended"), so the
    // emitter counts B as a SECOND lost record — the two never collapse into one.
    const path = tmpFile();
    writeFileSync(path, "");
    const cursor = new TranscriptCursor(path);
    expect(cursor.takeLines(overCap("a")).discard).toBe("started"); // A began (+1)
    // One call: A's closing newline, then B (no newline) which itself overflows.
    const boundary = cursor.takeLines(`endA\n${overCap("b")}`);
    expect(boundary.discard).toBe("started"); // B began (+1) even though A also ended
    expect(boundary.lines).toEqual([]); // nothing complete: B is still un-terminated
    expect(cursor.takeLines("endB\nok\n").discard).toBe("ended"); // B ends: 0 new
  });

  test("Finding A': two consecutive over-length records split across a chunk boundary count as TWO", () => {
    // Watcher-level: record A's terminating newline and record B's overflowing first
    // bytes land in the SAME 256 KiB read chunk. The old emitter inferred the
    // transition (lines.length===0 && bytes>0) and kept A's marker, so B's start
    // counted 0 and TWO lost records persisted as ONE. With the cursor's EXPLICIT
    // `started` transition both are counted: droppedCount === 2.
    const path = tmpFile();
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", () => {}, { onDrop: (d) => drops.push(d) });
    writeFileSync(path, "");
    watcher.observe(path);
    const over = () => "x".repeat(2 * 1024 * 1024);
    writeFileSync(path, `${over()}\n${over()}\n${JSON.stringify(assistant("after"))}\n`);
    watcher.finish();
    expect(drops.at(-1)!.droppedCount).toBe(2); // TWO oversized records, not one
    expect(drops.at(-1)!.cause).toBe("oversized");
    expect(JSON.stringify(drops)).not.toContain("x".repeat(64)); // content-free
  });

  test("Finding A': retire clears per-path discard state so a reused path starts fresh", () => {
    // The discard state lives ONLY on the cursor now, so retire()/finish() deleting
    // the cursor structurally clears it — no per-path marker leaks past a cursor's
    // life. A path re-observed after retire begins a fresh discard run: a later
    // over-length record on it still counts (it is NOT suppressed by a stale marker).
    const path = tmpFile();
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", () => {}, { onDrop: (d) => drops.push(d) });
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${"x".repeat(2 * 1024 * 1024)}\n`);
    watcher.retire(path); // drains + deletes the cursor
    const afterRetire = drops.at(-1)!.droppedCount;
    expect(afterRetire).toBeGreaterThanOrEqual(1);
    // Re-observe on an emptied file so the fresh cursor baselines at 0, then feed a
    // NEW over-length record. If a stale marker had leaked, this would count 0.
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${"y".repeat(2 * 1024 * 1024)}\n`);
    watcher.finish();
    expect(drops.at(-1)!.droppedCount).toBe(afterRetire + 1);
  });
});
