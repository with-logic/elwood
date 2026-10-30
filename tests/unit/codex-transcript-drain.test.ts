/**
 * Conformance coverage for the Codex bounded terminal drain (PRD §7A/§5.4/§9.2):
 * a budget-plus-wall-clock-bounded final drain flushes complete records, folds
 * unread backlog and partial-record loss into a single batched content-free drop,
 * tolerates a failed remaining-bytes probe, and stops on a contained fs failure.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CodexLineEmitter } from "../../src/codex/transcript/emit.ts";
import { CodexTranscriptFsGuard } from "../../src/codex/transcript/fs-guard.ts";
import type { CodexTranscriptEvent } from "../../src/codex/transcript/types.ts";
import { BoundedTranscriptCursor } from "../../src/core/transcript/cursor.ts";
import { drainToBudget, newTerminalBudget } from "../../src/core/transcript/drain.ts";
import {
  DropReporter,
  ReadErrorReporter,
  type TranscriptDropNotice,
} from "../../src/core/transcript/drops.ts";
import { tempDirForUnit } from "./helpers.ts";

/** A clock already past any deadline at each read after the first. */
function jumpingClock(): () => number {
  let t = 0;
  return () => (t += 1000);
}

function harness() {
  const events: CodexTranscriptEvent[] = [];
  const notices: TranscriptDropNotice[] = [];
  const drops = new DropReporter("s", (n: TranscriptDropNotice) => notices.push(n));
  const lines = new CodexLineEmitter("s", (e) => events.push(e), drops);
  const guard = new CodexTranscriptFsGuard(new ReadErrorReporter("s", undefined));
  return { events, notices, drops, lines, guard };
}

describe("Codex bounded terminal drain", () => {
  test("C-CODEX-20 drains to EOF within budget and flushes the final partial", () => {
    const path = join(tempDirForUnit(), "d.jsonl");
    writeFileSync(path, "");
    const cursor = new BoundedTranscriptCursor(path);
    appendFileSync(path, `${JSON.stringify({ type: "message" })}\ntrailing-partial`);
    const { events, lines, drops, guard } = harness();
    drainToBudget({ readFs: guard.read.bind(guard), lines, drops }, [cursor], newTerminalBudget());
    expect(events).toHaveLength(1); // the complete record; the partial is a drop
  });

  test("C-CODEX-20 an unread backlog past the wall-clock slice is a content-free drop", () => {
    const path = join(tempDirForUnit(), "backlog.jsonl");
    writeFileSync(path, "");
    const cursor = new BoundedTranscriptCursor(path);
    appendFileSync(path, `${"a".repeat(600 * 1024)}\n`);
    const { notices, lines, drops, guard } = harness();
    // A clock already past the deadline on the first check: only the first chunk is
    // read, and the rest of the delta surfaces as one unread_backlog drop.
    let t = 0;
    drainToBudget(
      { readFs: guard.read.bind(guard), lines, drops, sliceMs: 0, now: () => (t += 1000) },
      [cursor],
      newTerminalBudget(),
    );
    expect(notices.filter((n: TranscriptDropNotice) => n.cause === "unread_backlog")).toHaveLength(
      1,
    );
  });

  test("C-CODEX-20 a slice spent before the first read still delivers the final tail", () => {
    const path = join(tempDirForUnit(), "tail.jsonl");
    writeFileSync(path, "");
    const cursor = new BoundedTranscriptCursor(path);
    appendFileSync(path, `${JSON.stringify({ type: "message" })}\n`);
    const { events, notices, lines, drops, guard } = harness();
    let t = 0;
    drainToBudget(
      { readFs: guard.read.bind(guard), lines, drops, sliceMs: 0, now: () => (t += 1000) },
      [cursor],
      newTerminalBudget(),
    );
    expect(events.map((event) => event.item)).toEqual([{ type: "message" }]);
    expect(notices).toEqual([]);
  });

  test.each([
    ["a budget exhausted", { chunks: 1 }, {}],
    ["a slice spent", newTerminalBudget(), { sliceMs: 0, now: jumpingClock() }],
  ])("C-CODEX-20 %s mid-record drops the record with the backlog, never as unparseable", (_case, budget, clock) => {
    const path = join(tempDirForUnit(), "budget.jsonl");
    writeFileSync(path, "");
    const cursor = new BoundedTranscriptCursor(path);
    // A valid > 256 KiB record: one chunk reads only its first 256 KiB, buffered without
    // its newline. Its rest is the unread backlog, so the record is part of that one drop.
    appendFileSync(path, `${JSON.stringify({ type: "message", text: "b".repeat(600 * 1024) })}\n`);
    const { events, notices, lines, drops, guard } = harness();
    drainToBudget({ readFs: guard.read.bind(guard), lines, drops, ...clock }, [cursor], budget);
    expect(events).toEqual([]);
    expect(notices.map((n: TranscriptDropNotice) => n.cause)).toEqual(["unread_backlog"]);
  });

  test("C-CODEX-20 a failed remainingBytes probe at the budget edge accounts 0 backlog", () => {
    const path = join(tempDirForUnit(), "edge.jsonl");
    writeFileSync(path, "");
    const cursor = new BoundedTranscriptCursor(path);
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
    drainToBudget({ readFs: seam.read.bind(seam), lines, drops }, [cursor], { chunks: 1 });
    expect(notices.every((n: TranscriptDropNotice) => n.cause !== "unread_backlog")).toBe(true);
  });

  test("C-CODEX-20 a contained fs failure mid-drain stops without accounting", () => {
    const cursor = new BoundedTranscriptCursor(join(tempDirForUnit(), "fail.jsonl"));
    writeFileSync(cursor.path, "data\n");
    const { notices, lines, drops } = harness();
    const failing = {
      read<T>(_p: string, _r: () => T): T | undefined {
        return undefined; // every read fails: drain returns 0 (nothing to account)
      },
    };
    drainToBudget(
      { readFs: failing.read.bind(failing), lines, drops },
      [cursor],
      newTerminalBudget(),
    );
    expect(notices).toHaveLength(0);
  });
});
