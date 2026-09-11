/**
 * Conformance coverage for the bounded Codex transcript watcher and the shared
 * drop/read-error warning builders.
 * Covers PRD §7A/§5.4: idempotent observe, contained construction/scan failures,
 * the per-scan chunk budget, oversized drops, and content-free codex-tagged
 * live, content-free warnings.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CodexTranscriptEvent } from "../../src/codex/transcript/types.ts";
import { codexDropWarning, codexReadErrorWarning } from "../../src/codex/transcript/warnings.ts";
import { CodexTranscriptWatcher } from "../../src/codex/transcript/watcher.ts";
import {
  resetByteReaderForTests,
  setByteReaderForTests,
} from "../../src/core/transcript/cursor-io.ts";
import type {
  TranscriptDropNotice,
  TranscriptReadErrorNotice,
} from "../../src/core/transcript/drops.ts";
import { tempDirForUnit } from "./helpers.ts";

afterEach(() => {
  resetByteReaderForTests();
  vi.useRealTimers();
});

function tmp(name = "codex.jsonl"): string {
  return join(tempDirForUnit(), name);
}

describe("Codex transcript watcher (bounded)", () => {
  test("C-CODEX-20 observe is idempotent per path and switches to a new path", () => {
    const events: CodexTranscriptEvent[] = [];
    const a = tmp("a.jsonl");
    const b = tmp("b.jsonl");
    writeFileSync(a, "");
    writeFileSync(b, "");
    const watcher = new CodexTranscriptWatcher("s", (e) => events.push(e), { scanIntervalMs: 5 });
    watcher.observe(a);
    watcher.observe(a); // same path: no-op, keeps the cursor + offset
    appendFileSync(a, `${JSON.stringify({ type: "message" })}\n`);
    watcher.scan();
    watcher.observe(b); // switch: drops a's cursor
    appendFileSync(b, `${JSON.stringify({ type: "note" })}\n`);
    watcher.scan();
    watcher.finish();
    expect(events).toHaveLength(2);
  });

  test("C-CODEX-20 observe contains a cursor-construction failure and stays unset", () => {
    const errs: TranscriptReadErrorNotice[] = [];
    const watcher = new CodexTranscriptWatcher("s", () => undefined, {
      onReadError: (n) => errs.push(n),
    });
    // A NUL byte in the path makes the cursor ctor's statSync throw (non-ENOENT); the
    // fs guard contains it, records a read error, and leaves the cursor unset.
    watcher.observe("bad\0path.jsonl");
    expect(errs).toHaveLength(1);
    expect(() => {
      watcher.scan();
      watcher.flush();
      watcher.finish();
    }).not.toThrow();
  });

  test("C-CODEX-20 the scan interval fires and drives a scan tick", () => {
    vi.useFakeTimers();
    const path = tmp("tick.jsonl");
    writeFileSync(path, "");
    const events: CodexTranscriptEvent[] = [];
    const watcher = new CodexTranscriptWatcher("s", (e) => events.push(e), { scanIntervalMs: 1 });
    watcher.observe(path);
    appendFileSync(path, `${JSON.stringify({ type: "message" })}\n`);
    // Advance past one interval so the timer's scan arrow runs (not a manual scan()).
    vi.advanceTimersByTime(2);
    watcher.finish();
    expect(events).toHaveLength(1);
  });

  test("C-CODEX-20 a scan with no new bytes emits nothing and no drop", () => {
    const path = tmp("idle.jsonl");
    writeFileSync(path, "");
    const events: CodexTranscriptEvent[] = [];
    const notices: TranscriptDropNotice[] = [];
    const watcher = new CodexTranscriptWatcher("s", (e) => events.push(e), {
      onDrop: (n) => notices.push(n),
    });
    watcher.observe(path);
    watcher.scan(); // no growth: readChunk returns empty text, canContinueNow:false
    watcher.finish();
    expect(events).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  test("C-CODEX-20 scan honors the per-pass chunk budget across ticks", () => {
    const path = tmp("stream.jsonl");
    writeFileSync(path, "");
    const events: CodexTranscriptEvent[] = [];
    // A FROZEN clock: this asserts the CHUNK budget bounds a scan and that repeated
    // passes eventually drain all 18. finish()'s 50 ms wall-clock slice would
    // otherwise truncate these 4.6 MB on a loaded machine — truthful behavior (§5.4)
    // that would make the exact count flaky.
    const watcher = new CodexTranscriptWatcher("s", (e) => events.push(e), { now: () => 0 });
    watcher.observe(path);
    // 18 JSON records ≈ one 256 KiB chunk each of the 16-chunk budget: scan 1 can't
    // drain all 18 (a budget regression would, failing the < 18 assertion below).
    const big = JSON.stringify({ type: "message", pad: "m".repeat(256 * 1024 - 40) });
    for (let i = 0; i < 18; i += 1) appendFileSync(path, `${big}\n`);
    watcher.scan();
    const afterFirst = events.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(18); // budget bounded the first pass — NOT all 18
    watcher.scan();
    watcher.finish();
    expect(events.length).toBeGreaterThan(afterFirst); // the second pass made progress
    expect(events.length).toBe(18); // everything eventually drained
  });

  test("C-CODEX-20 a giant no-newline record surfaces an oversized drop, no event", () => {
    const path = tmp("giant.jsonl");
    writeFileSync(path, "");
    const events: CodexTranscriptEvent[] = [];
    const notices: TranscriptDropNotice[] = [];
    const watcher = new CodexTranscriptWatcher("s", (e) => events.push(e), {
      onDrop: (n) => notices.push(n),
    });
    watcher.observe(path);
    appendFileSync(path, "g".repeat(1024 * 1024 + 50));
    watcher.scan();
    watcher.finish();
    expect(events).toHaveLength(0);
    expect(notices.some((n) => n.cause === "oversized")).toBe(true);
  });

  test("C-CODEX-20 a contained read failure during scan records a read error", () => {
    const path = tmp("scanfail.jsonl");
    writeFileSync(path, "");
    const errs: TranscriptReadErrorNotice[] = [];
    const watcher = new CodexTranscriptWatcher("s", () => undefined, {
      onReadError: (n) => errs.push(n),
    });
    watcher.observe(path);
    appendFileSync(path, "data\n");
    setByteReaderForTests(() => {
      throw Object.assign(new Error("read failed"), { code: "EIO" });
    });
    watcher.scan();
    watcher.stop();
    expect(errs.at(-1)).toMatchObject({ lastErrorCode: "EIO" });
  });
});

describe("Codex transcript warning builders", () => {
  const dropNotice: TranscriptDropNotice = {
    elwoodSessionId: "s",
    path: "/t",
    cause: "unread_backlog",
  };
  const drop = codexDropWarning(dropNotice);
  const read = codexReadErrorWarning({
    elwoodSessionId: "s",
    path: "/t",
    lastErrorCode: "ENOENT",
  });

  test("C-CODEX-20 drop + read-error warnings are content-free and codex-tagged", () => {
    expect(drop).toMatchObject({
      agent: "codex",
      source: "terminal",
      code: "transcript_records_dropped",
      cause: "unread_backlog",
      transcriptPath: "/t",
    });
    expect(drop.message).toContain("unread transcript backlog");
    expect(drop.raw).toBe("transcript_records_dropped cause=unread_backlog");
    expect(read).toMatchObject({
      agent: "codex",
      code: "transcript_read_error",
      lastErrorCode: "ENOENT",
      transcriptPath: "/t",
    });
    expect(read.raw).toBe("transcript_read_error code=ENOENT");
  });

  test("C-CODEX-20 each drop cause has a distinct human phrase", () => {
    const phrases = (["unparseable", "oversized", "unread_backlog"] as const).map(
      (cause) => codexDropWarning({ ...dropNotice, cause }).message,
    );
    expect(new Set(phrases).size).toBe(3);
  });
});
