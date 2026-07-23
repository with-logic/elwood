/**
 * Focused coverage for the bounded terminal drain (retire/finish).
 * Covers PRD §5.4/§9.2 (C-CLAUDE-15): a teardown drain shares ONE chunk budget
 * across cursors; a backlog left unread when the budget is spent is surfaced as
 * a content-free drop and termination completes rather than a 256 MiB sync loop.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TranscriptCursor } from "../../src/claude/transcript/cursor.ts";
import { type DrainContext, drainToBudget } from "../../src/claude/transcript/drain.ts";
import { DropTracker, type TranscriptDropNotice } from "../../src/claude/transcript/drops.ts";
import { type ClaudeTranscriptEvent, LineEmitter } from "../../src/claude/transcript/emit.ts";

const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "elwood-drain-")), "t.jsonl");

/**
 * A real drain context: real cursor reads, real parse/emit, real drop accounting.
 * `now` is injectable so a test can prove the per-call wall-clock slice bounds work
 * without wall time; it defaults to a fixed clock that never trips the deadline.
 */
function harness(now: () => number = () => 0) {
  const events: ClaudeTranscriptEvent[] = [];
  const drops: TranscriptDropNotice[] = [];
  const dropTracker = new DropTracker("s1", (d) => drops.push(d));
  const lines = new LineEmitter("s1", (e) => events.push(e), dropTracker);
  const context: DrainContext = {
    readFs: <T>(_path: string, read: () => T) => read(),
    lines,
    drops: dropTracker,
    sliceMs: 50,
    now,
  };
  return { context, events, drops };
}

describe("C-CLAUDE-15 bounded terminal drain", () => {
  test("a fully-drained cursor emits every record and accounts no backlog", () => {
    const path = tmpFile();
    writeFileSync(path, "");
    const cursor = new TranscriptCursor(path);
    writeFileSync(
      path,
      `${[assistant("a"), assistant("b")].map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    const { context, events, drops } = harness();
    drainToBudget(context, [cursor], { chunks: 1024 });
    expect(events).toHaveLength(2);
    expect(drops).toEqual([]); // fully drained: no unread backlog to account
  });

  test("a backlog past the budget is surfaced as a content-free drop, not read", () => {
    // One 256 KiB chunk per budget unit: a 3-chunk delta with a 1-chunk budget
    // leaves ~2 chunks unread. The drain STOPS and surfaces one unread_backlog drop
    // instead of looping to EOF, proving teardown can't run an unbounded loop.
    const path = tmpFile();
    writeFileSync(path, "");
    const cursor = new TranscriptCursor(path);
    const filler = "q".repeat(256 * 1024); // one record ≈ one 256 KiB chunk
    const records = Array.from({ length: 3 }, () => JSON.stringify(assistant(filler)));
    writeFileSync(path, `${records.join("\n")}\n`);
    const { context, events, drops } = harness();
    drainToBudget(context, [cursor], { chunks: 1 }); // budget exhausted after one chunk
    // The unread backlog was surfaced as a content-free drop, not read to EOF.
    expect(drops.some((d) => d.cause === "unread_backlog")).toBe(true);
    // Not everything was read: fewer than all 3 records were emitted (bounded work).
    expect(events.length).toBeLessThan(3);
  });

  test("a backlog whose size cannot be re-read is accounted as zero, not a crash", () => {
    // Budget spent (0), and every fs read is contained to undefined (a persistent
    // rotation/removal fault, exactly like the watcher's readFs guard). The backlog
    // read yields undefined, so it falls back to 0 bytes — no spurious drop, no crash.
    const path = tmpFile();
    writeFileSync(path, `${JSON.stringify(assistant("pending"))}\n`);
    const cursor = new TranscriptCursor(path);
    const { context, drops } = harness();
    const guarded: DrainContext = { ...context, readFs: () => undefined };
    // Zero budget → the read loop is skipped and remainingBytes() is the only read;
    // it is contained to undefined, and drainToBudget falls back to 0 bytes.
    expect(() => drainToBudget(guarded, [cursor], { chunks: 0 })).not.toThrow();
    expect(drops).toEqual([]); // no backlog drop recorded for an unreadable size
  });

  test("a truncated cursor reports zero remaining bytes (no negative backlog)", () => {
    // remainingBytes() must clamp to 0 when the file shrank below the cursor offset
    // (a rotation/truncation), so a truncated file never yields a negative backlog.
    const path = tmpFile();
    writeFileSync(path, `${JSON.stringify(assistant("aaaa"))}\n`);
    const cursor = new TranscriptCursor(path); // offset baselines at the full size
    writeFileSync(path, ""); // truncate below the offset
    expect(cursor.remainingBytes()).toBe(0);
  });

  test("a backlog past the per-call wall-clock slice is dropped, not read to EOF", () => {
    // The drain must stop at its wall-clock deadline even with chunk budget to spare,
    // so a single call can never monopolize the event loop grinding a huge backlog.
    // A monotonic clock jumps PAST the 50ms slice after the first chunk, so the read
    // loop exits on the deadline (not the budget) with the rest of the file unread —
    // and that unread backlog is surfaced as a content-free drop rather than looped.
    const path = tmpFile();
    writeFileSync(path, "");
    const cursor = new TranscriptCursor(path);
    const filler = "z".repeat(256 * 1024); // one record ≈ one 256 KiB chunk
    const records = Array.from({ length: 4 }, () => JSON.stringify(assistant(filler)));
    writeFileSync(path, `${records.join("\n")}\n`);
    let calls = 0;
    // First deadline check (loop entry) is under the slice; after one chunk the clock
    // jumps past it, so the loop yields with a large budget (100) still unspent.
    const clock = () => (calls++ === 0 ? 0 : 1_000);
    const { context, events, drops } = harness(clock);
    drainToBudget(context, [cursor], { chunks: 100 }); // budget ample; the SLICE bounds it
    expect(drops.some((d) => d.cause === "unread_backlog")).toBe(true); // backlog dropped
    expect(events.length).toBeLessThan(4); // slice cut the drain short: not read to EOF
  });

  test("retire and finish draw from ONE shared watcher-wide budget", () => {
    // A single mutable budget threaded through two drainToBudget calls models the
    // watcher's shared `terminalBudget`: a first drain (a retire) that spends the
    // budget must leave the SECOND drain (finish) budget-limited — proving retire
    // does NOT get a fresh full budget and aggregate terminal work stays bounded.
    const firstPath = tmpFile();
    const secondPath = tmpFile();
    writeFileSync(firstPath, "");
    writeFileSync(secondPath, "");
    const first = new TranscriptCursor(firstPath);
    const second = new TranscriptCursor(secondPath);
    const filler = "y".repeat(256 * 1024); // one record ≈ one 256 KiB chunk
    const rows = (n: number) =>
      `${Array.from({ length: n }, () => JSON.stringify(assistant(filler))).join("\n")}\n`;
    writeFileSync(firstPath, rows(3)); // a 3-chunk backlog for the first (retire) cursor
    writeFileSync(secondPath, rows(2)); // a 2-chunk backlog for the second (finish) cursor
    const shared = { chunks: 2 }; // ONE budget for BOTH calls: only two chunks total
    const { context, drops } = harness();
    drainToBudget(context, [first], shared); // retire: spends both budget chunks
    expect(shared.chunks).toBe(0); // the shared budget is exhausted by the first drain
    drainToBudget(context, [second], shared); // finish: no budget left → all backlog dropped
    // The second cursor read nothing (budget already spent), so its whole backlog is a drop.
    expect(drops.some((d) => d.path === secondPath && d.cause === "unread_backlog")).toBe(true);
  });
});
