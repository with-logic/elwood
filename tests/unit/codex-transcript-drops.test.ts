/**
 * Conformance coverage for Codex transcript drop/read-error reporting, the fs
 * guard, the line emitter, and the bounded terminal drain.
 * Covers PRD §7A/§5.4/§9.2: each lost record (unparseable, oversized, unread_backlog)
 * or contained fs failure surfaces a live, content-free notice — no running count,
 * no persistence — and drop DELIVERY is coalesced per (path, cause) per pass so a
 * chunk of millions of malformed lines cannot fan out millions of warnings.
 */

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CodexTranscriptCursor } from "../../src/codex/transcript/cursor.ts";
import {
  type CodexDropNotice,
  CodexDropReporter,
  type CodexReadErrorNotice,
  CodexReadErrorReporter,
} from "../../src/codex/transcript/drops.ts";
import { CodexLineEmitter } from "../../src/codex/transcript/emit.ts";
import { CodexTranscriptFsGuard } from "../../src/codex/transcript/fs-guard.ts";
import type { CodexTranscriptEvent } from "../../src/codex/transcript/types.ts";
import { tempDirForUnit } from "./helpers.ts";

describe("Codex drop + read-error reporting", () => {
  test("C-CODEX-20 distinct causes each surface once per pass; delivery waits for flush", () => {
    const notices: CodexDropNotice[] = [];
    const reporter = new CodexDropReporter("s1", (n: CodexDropNotice) => notices.push(n));
    reporter.record("/t"); // unparseable
    reporter.record("/t"); // coalesced into the same incident
    reporter.drop("/t", "oversized");
    expect(notices).toEqual([]); // nothing delivered until the pass flushes
    reporter.flushPass();
    expect(notices).toEqual([
      { elwoodSessionId: "s1", path: "/t", cause: "unparseable" },
      { elwoodSessionId: "s1", path: "/t", cause: "oversized" },
    ]);
  });

  test("C-CODEX-20 a reporter with no sink still records without throwing", () => {
    const reporter = new CodexDropReporter("s", undefined);
    expect(() => {
      reporter.record("/t");
      reporter.drop("/t", "unread_backlog");
      reporter.flushPass();
    }).not.toThrow();
  });

  test("C-CODEX-20 read-error reporter surfaces the code and normalizes a missing/numeric code", () => {
    const errs: CodexReadErrorNotice[] = [];
    const reporter = new CodexReadErrorReporter("s", (n: CodexReadErrorNotice) => errs.push(n));
    reporter.record("/t", { code: "EISDIR" });
    reporter.record("/t", new Error("boom")); // no `.code` → UNKNOWN
    reporter.record("/t", { code: 5 }); // a NUMERIC code must NOT round-trip → UNKNOWN
    expect(errs.map((e: CodexReadErrorNotice) => e.lastErrorCode)).toEqual([
      "EISDIR",
      "UNKNOWN",
      "UNKNOWN",
    ]);
    const silent = new CodexReadErrorReporter("s", undefined);
    expect(() => silent.record("/t", {})).not.toThrow();
  });
});

describe("Codex fs guard", () => {
  test("C-CODEX-20 contains a sync read failure and records it", () => {
    const errs: CodexReadErrorNotice[] = [];
    const guard = new CodexTranscriptFsGuard(
      new CodexReadErrorReporter("s", (n: CodexReadErrorNotice) => errs.push(n)),
    );
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
  const drops = new CodexDropReporter("s", (n: CodexDropNotice) => notices.push(n));
  const lines = new CodexLineEmitter("s", (e) => events.push(e), drops);
  const guard = new CodexTranscriptFsGuard(new CodexReadErrorReporter("s", undefined));
  return { events, notices, drops, lines, guard };
}

describe("Codex line emitter", () => {
  test("C-CODEX-20 emits parseable lines, skips blanks, drops malformed", () => {
    const { events, notices, drops, lines } = harness();
    const cursor = new CodexTranscriptCursor(join(tempDirForUnit(), "x.jsonl"));
    lines.emitLines("/p", "", cursor); // empty text early-returns
    lines.emitLines("/p", `{"type":"note"}\n   \n{oops}\n`, cursor);
    drops.flushPass();
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toMatchObject({ kind: "other", label: "note" });
    expect(notices.at(-1)).toMatchObject({ cause: "unparseable" });
  });

  test("C-CODEX-20 an over-length record via emitLines is one oversized drop", () => {
    const { notices, drops, lines } = harness();
    const cursor = new CodexTranscriptCursor(join(tempDirForUnit(), "x.jsonl"));
    lines.emitLines("/p", "q".repeat(1024 * 1024 + 10), cursor);
    drops.flushPass();
    expect(notices.filter((n: CodexDropNotice) => n.cause === "oversized")).toHaveLength(1);
  });

  test("C-CODEX-20 ENDING a discard surfaces no new drop (only the start counted)", () => {
    const { notices, drops, lines } = harness();
    const cursor = new CodexTranscriptCursor(join(tempDirForUnit(), "x.jsonl"));
    lines.emitLines("/p", "q".repeat(1024 * 1024 + 10), cursor); // starts discard (one drop)
    // The next chunk ENDS the discard: no new over-length record began, so no new drop.
    lines.emitLines("/p", "tail-of-record\n", cursor);
    drops.flushPass();
    expect(notices.filter((n: CodexDropNotice) => n.cause === "oversized")).toHaveLength(1);
  });
});
