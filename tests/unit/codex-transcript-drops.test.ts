/**
 * Conformance coverage for Codex transcript drop/read-error accounting, the fs
 * guard, the line emitter, and the bounded terminal drain.
 * Covers PRD §7A/§5.4: content-free drop incidents (unparseable, oversized,
 * unread_backlog), batched persistence, contained fs failures, and a
 * budget-plus-wall-clock-bounded final drain.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CodexTranscriptCursor } from "../../src/codex/transcript/cursor.ts";
import { drainToBudget, newTerminalBudget } from "../../src/codex/transcript/drain.ts";
import {
  type CodexDropNotice,
  CodexDropTracker,
  type CodexReadErrorNotice,
  CodexReadErrorTracker,
} from "../../src/codex/transcript/drops.ts";
import { CodexLineEmitter } from "../../src/codex/transcript/emit.ts";
import { CodexTranscriptFsGuard } from "../../src/codex/transcript/fs-guard.ts";
import type { CodexTranscriptEvent } from "../../src/codex/transcript/types.ts";
import { tempDirForUnit } from "./helpers.ts";

describe("Codex drop + read-error tracking", () => {
  test("C-API-12 drops advance in memory and persist only on flush; seed continues", () => {
    const notices: CodexDropNotice[] = [];
    const tracker = new CodexDropTracker("s1", (n) => notices.push(n), {
      droppedCount: 4,
      droppedBytes: 40,
    });
    tracker.record("/t", "{bad");
    tracker.recordBytes("/t", 100, 1, "oversized");
    expect(notices).toHaveLength(0); // nothing persisted until flush
    tracker.flush();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ droppedCount: 6, cause: "oversized" });
    expect(notices[0]?.droppedBytes).toBe(40 + Buffer.byteLength("{bad") + 100);
    tracker.flush(); // nothing dirty: no second persist
    expect(notices).toHaveLength(1);
  });

  test("C-API-12 a tracker with no sink and no seed still counts without throwing", () => {
    const tracker = new CodexDropTracker("s", undefined);
    tracker.record("/t", "x");
    expect(() => tracker.flush()).not.toThrow();
  });

  test("C-API-12 read-error tracker counts, seeds, and normalizes a missing code", () => {
    const errs: CodexReadErrorNotice[] = [];
    const tracker = new CodexReadErrorTracker("s", (n) => errs.push(n), { errorCount: 2 });
    tracker.record("/t", { code: "EISDIR" });
    tracker.record("/t", new Error("boom")); // no `.code` → UNKNOWN
    tracker.record("/t", { code: 5 }); // a NUMERIC code must NOT round-trip → UNKNOWN
    expect(errs.map((e) => e.errorCount)).toEqual([3, 4, 5]);
    expect(errs.map((e) => e.lastErrorCode)).toEqual(["EISDIR", "UNKNOWN", "UNKNOWN"]);
    const silent = new CodexReadErrorTracker("s", undefined);
    expect(() => silent.record("/t", {})).not.toThrow();
  });
});

describe("Codex fs guard", () => {
  test("C-API-12 contains a sync read failure and records it", () => {
    const errs: CodexReadErrorNotice[] = [];
    const guard = new CodexTranscriptFsGuard(new CodexReadErrorTracker("s", (n) => errs.push(n)));
    expect(guard.read("/t", () => 42)).toBe(42);
    const bad = guard.read("/t", () => {
      throw new Error("nope");
    });
    expect(bad).toBeUndefined();
    expect(errs).toHaveLength(1);
  });
});

function harness() {
  const events: CodexTranscriptEvent[] = [];
  const notices: CodexDropNotice[] = [];
  const drops = new CodexDropTracker("s", (n) => notices.push(n));
  const lines = new CodexLineEmitter("s", (e) => events.push(e), drops);
  const guard = new CodexTranscriptFsGuard(new CodexReadErrorTracker("s", undefined));
  return { events, notices, drops, lines, guard };
}

describe("Codex line emitter", () => {
  test("C-API-12 emits parseable lines, skips blanks, drops malformed", () => {
    const { events, notices, drops, lines } = harness();
    const cursor = new CodexTranscriptCursor(join(tempDirForUnit(), "x.jsonl"));
    lines.emitLines("/p", "", cursor); // empty text early-returns
    lines.emitLines("/p", `{"type":"note"}\n   \n{oops}\n`, cursor);
    drops.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toMatchObject({ kind: "other", label: "note" });
    expect(notices.at(-1)).toMatchObject({ cause: "unparseable" });
  });

  test("C-API-12 an over-length record via emitLines is an oversized drop", () => {
    const { notices, drops, lines } = harness();
    const cursor = new CodexTranscriptCursor(join(tempDirForUnit(), "x.jsonl"));
    lines.emitLines("/p", "q".repeat(1024 * 1024 + 10), cursor);
    drops.flush();
    expect(notices.at(-1)).toMatchObject({ cause: "oversized", droppedCount: 1 });
  });

  test("C-API-12 ENDING a discard reports bytes but no new record (count stays 1)", () => {
    const { notices, drops, lines } = harness();
    const cursor = new CodexTranscriptCursor(join(tempDirForUnit(), "x.jsonl"));
    lines.emitLines("/p", "q".repeat(1024 * 1024 + 10), cursor); // starts discard (+1)
    // The next chunk ENDS the discard: its tail bytes report with the "ended"
    // transition, so the emitter adds 0 records — only the tail bytes.
    lines.emitLines("/p", "tail-of-record\n", cursor);
    drops.flush();
    expect(notices.at(-1)?.droppedCount).toBe(1);
  });
});

describe("Codex bounded terminal drain", () => {
  test("C-API-12 drains to EOF within budget and flushes the final partial", () => {
    const path = join(tempDirForUnit(), "d.jsonl");
    writeFileSync(path, "");
    const cursor = new CodexTranscriptCursor(path);
    appendFileSync(path, `${JSON.stringify({ type: "message" })}\ntrailing-partial`);
    const { events, lines, drops, guard } = harness();
    drainToBudget({ readFs: guard.read.bind(guard), lines, drops }, cursor, newTerminalBudget());
    expect(events).toHaveLength(1); // the complete record; the partial is a drop
  });

  test("C-API-12 an unread backlog past the wall-clock slice is a content-free drop", () => {
    const path = join(tempDirForUnit(), "backlog.jsonl");
    writeFileSync(path, "");
    const cursor = new CodexTranscriptCursor(path);
    appendFileSync(path, `${"a".repeat(600 * 1024)}\n`);
    const { notices, lines, drops, guard } = harness();
    // A clock already past the deadline on the FIRST check: no chunk read, the whole
    // delta is accounted as an unread_backlog drop.
    let t = 0;
    drainToBudget(
      { readFs: guard.read.bind(guard), lines, drops, sliceMs: 0, now: () => (t += 1000) },
      cursor,
      newTerminalBudget(),
    );
    expect(notices.at(-1)).toMatchObject({ cause: "unread_backlog", droppedCount: 1 });
  });

  test("C-API-12 a budget exhausted mid-file leaves a backlog drop", () => {
    const path = join(tempDirForUnit(), "budget.jsonl");
    writeFileSync(path, "");
    const cursor = new CodexTranscriptCursor(path);
    // A > 256 KiB record: a 1-chunk budget reads only the first 256 KiB (buffered,
    // no newline), so the remainder is an unread_backlog incident and the flushed
    // partial folds a second (unparseable) incident into the SAME batched aggregate.
    appendFileSync(path, `${"b".repeat(600 * 1024)}\n`);
    const { notices, lines, drops, guard } = harness();
    drainToBudget({ readFs: guard.read.bind(guard), lines, drops }, cursor, { chunks: 1 });
    expect(notices).toHaveLength(1); // one batched flush at the end of the drain
    expect(notices[0]?.droppedCount).toBe(2); // backlog + partial incidents
    expect(notices[0]?.droppedBytes).toBeGreaterThan(300 * 1024);
  });

  test("C-API-12 a failed remainingBytes probe at the budget edge accounts 0 backlog", () => {
    const path = join(tempDirForUnit(), "edge.jsonl");
    writeFileSync(path, "");
    const cursor = new CodexTranscriptCursor(path);
    appendFileSync(path, `${"c".repeat(600 * 1024)}\n`);
    const { notices, lines, drops } = harness();
    // A readFs that returns the chunk read but undefined for the final remainingBytes
    // probe, so the `?? 0` fallback is taken and no backlog is over-counted.
    let call = 0;
    const seam = {
      read<T>(_p: string, run: () => T): T | undefined {
        call += 1;
        return call === 1 ? run() : undefined;
      },
    };
    drainToBudget({ readFs: seam.read.bind(seam), lines, drops }, cursor, { chunks: 1 });
    drops.flush();
    expect(notices.every((n) => n.cause !== "unread_backlog")).toBe(true);
  });

  test("C-API-12 a contained fs failure mid-drain stops without accounting", () => {
    const path = join(tempDirForUnit(), "fail.jsonl");
    writeFileSync(path, "data\n");
    const cursor = new CodexTranscriptCursor(join(tempDirForUnit(), "empty.jsonl"));
    writeFileSync(cursor.path, "data\n");
    const { notices, lines, drops } = harness();
    const failing = {
      read<T>(_p: string, _r: () => T): T | undefined {
        return undefined; // every read fails: drain returns 0 (nothing to account)
      },
    };
    drainToBudget(
      { readFs: failing.read.bind(failing), lines, drops },
      cursor,
      newTerminalBudget(),
    );
    expect(notices).toHaveLength(0);
  });
});
