/**
 * Conformance coverage for the Codex bounded terminal drain (PRD §7A/§5.4/§9.2):
 * a budget-plus-wall-clock-bounded final drain flushes complete records, folds
 * unread backlog and partial-record loss into a single batched content-free drop,
 * tolerates a failed remaining-bytes probe, and stops on a contained fs failure.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CodexTranscriptCursor } from "../../src/codex/transcript/cursor.ts";
import { drainToBudget, newTerminalBudget } from "../../src/codex/transcript/drain.ts";
import {
  type CodexDropNotice,
  CodexDropTracker,
  CodexReadErrorTracker,
} from "../../src/codex/transcript/drops.ts";
import { CodexLineEmitter } from "../../src/codex/transcript/emit.ts";
import { CodexTranscriptFsGuard } from "../../src/codex/transcript/fs-guard.ts";
import type { CodexTranscriptEvent } from "../../src/codex/transcript/types.ts";
import { tempDirForUnit } from "./helpers.ts";

function harness() {
  const events: CodexTranscriptEvent[] = [];
  const notices: CodexDropNotice[] = [];
  const drops = new CodexDropTracker("s", (n) => notices.push(n));
  const lines = new CodexLineEmitter("s", (e) => events.push(e), drops);
  const guard = new CodexTranscriptFsGuard(new CodexReadErrorTracker("s", undefined));
  return { events, notices, drops, lines, guard };
}

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
