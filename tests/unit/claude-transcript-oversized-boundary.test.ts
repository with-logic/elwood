/**
 * Regression coverage for the mirrored-discard undercount + per-path marker leak.
 * Covers PRD §5.4 (C-CLAUDE-15): the cursor reports whether THIS call began a fresh
 * over-length discard, so two consecutive over-length records split across one chunk
 * boundary surface TWO live drop warnings (not one), and no per-path discard marker
 * survives retire()/finish().
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
const oversized = (drops: readonly TranscriptDropNotice[]) =>
  drops.filter((d) => d.cause === "oversized").length;

describe("C-CLAUDE-15 over-length discard boundary", () => {
  test("Finding A': one chunk that ENDS one over-length record and STARTS the next reports a new drop", () => {
    // The undercount bug at the cursor level: record A's terminating newline is
    // consumed in the SAME call that then buffers a partial record B which itself
    // overflows. The cursor returns `startedOversizedDrop: true` (a fresh drop began),
    // so the emitter surfaces B as a SECOND lost record — the two never collapse.
    const path = tmpFile();
    writeFileSync(path, "");
    const cursor = new TranscriptCursor(path);
    expect(cursor.takeLines(overCap("a")).startedOversizedDrop).toBe(true); // A began (drop)
    // One call: A's closing newline, then B (no newline) which itself overflows.
    const boundary = cursor.takeLines(`endA\n${overCap("b")}`);
    expect(boundary.startedOversizedDrop).toBe(true); // B began even though A also ended
    expect(boundary.lines).toEqual([]); // nothing complete: B is still un-terminated
    expect(cursor.takeLines("endB\nok\n").startedOversizedDrop).toBe(false); // B ends: no new drop
  });

  test("two over-length records in one pass coalesce to ONE oversized drop (bounded delivery)", () => {
    // Watcher-level: record A's terminating newline and record B's overflowing first
    // bytes land in the SAME 256 KiB read chunk. The cursor still flags BOTH discards
    // per-call (see the sibling cursor test), but drop DELIVERY is coalesced per
    // (path, cause) per pass (§9.2), so the incident surfaces as ONE oversized warning
    // rather than one synchronous emit per over-length record.
    const path = tmpFile();
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", () => {}, {
      onDrop: (d: TranscriptDropNotice) => drops.push(d),
    });
    writeFileSync(path, "");
    watcher.observe(path);
    const over = () => "x".repeat(2 * 1024 * 1024);
    writeFileSync(path, `${over()}\n${over()}\n${JSON.stringify(assistant("after"))}\n`);
    watcher.finish();
    expect(oversized(drops)).toBe(1); // coalesced: one live oversized warning this pass
    expect(JSON.stringify(drops)).not.toContain("x".repeat(64)); // content-free
  });

  test("Finding A': retire clears per-path discard state so a reused path starts fresh", () => {
    // The discard state lives ONLY on the cursor now, so retire()/finish() deleting
    // the cursor structurally clears it — no per-path marker leaks past a cursor's
    // life. A path re-observed after retire begins a fresh discard run: a later
    // over-length record on it still surfaces a drop (it is NOT suppressed by a stale marker).
    const path = tmpFile();
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", () => {}, { onDrop: (d) => drops.push(d) });
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${"x".repeat(2 * 1024 * 1024)}\n`);
    watcher.retire(path); // drains + deletes the cursor
    const afterRetire = oversized(drops);
    expect(afterRetire).toBeGreaterThanOrEqual(1);
    // Re-observe on an emptied file so the fresh cursor baselines at 0, then feed a
    // NEW over-length record. If a stale marker had leaked, this would surface no drop.
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${"y".repeat(2 * 1024 * 1024)}\n`);
    watcher.finish();
    expect(oversized(drops)).toBe(afterRetire + 1);
  });
});
