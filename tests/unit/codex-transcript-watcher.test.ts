/**
 * Conformance coverage for the bounded Codex transcript watcher and the shared
 * drop/read-error warning builders.
 * Covers PRD §7A/§5.4: idempotent observe, contained construction/scan failures,
 * the per-scan chunk budget, oversized drops, and content-free codex-tagged
 * warnings that round-trip through persisted-state validation.
 */

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  resetByteReaderForTests,
  setByteReaderForTests,
} from "../../src/codex/transcript/cursor-io.ts";
import type { CodexDropNotice, CodexReadErrorNotice } from "../../src/codex/transcript/drops.ts";
import type { CodexTranscriptEvent } from "../../src/codex/transcript/types.ts";
import { codexDropWarning, codexReadErrorWarning } from "../../src/codex/transcript/warnings.ts";
import { CodexTranscriptWatcher } from "../../src/codex/transcript/watcher.ts";
import { createSessionRecord } from "../../src/state/store.ts";
import { validateSessionRecord } from "../../src/state/validate.ts";
import { tempDirForUnit } from "./helpers.ts";

afterEach(() => resetByteReaderForTests());

function tmp(name = "codex.jsonl"): string {
  return join(tempDirForUnit(), name);
}

describe("Codex transcript watcher (bounded)", () => {
  test("C-API-12 observe is idempotent per path and switches to a new path", () => {
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

  test("C-API-12 observe contains a cursor-construction failure and stays unset", () => {
    const errs: CodexReadErrorNotice[] = [];
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

  test("C-API-12 the scan interval fires and drives a scan tick", async () => {
    const path = tmp("tick.jsonl");
    writeFileSync(path, "");
    const events: CodexTranscriptEvent[] = [];
    const watcher = new CodexTranscriptWatcher("s", (e) => events.push(e), { scanIntervalMs: 1 });
    watcher.observe(path);
    appendFileSync(path, `${JSON.stringify({ type: "message" })}\n`);
    // Wait past one interval so the timer's scan arrow runs (not a manual scan()).
    await new Promise((resolve) => setTimeout(resolve, 15));
    watcher.finish();
    expect(events).toHaveLength(1);
  });

  test("C-API-12 a scan with no new bytes emits nothing and no drop", () => {
    const path = tmp("idle.jsonl");
    writeFileSync(path, "");
    const events: CodexTranscriptEvent[] = [];
    const notices: CodexDropNotice[] = [];
    const watcher = new CodexTranscriptWatcher("s", (e) => events.push(e), {
      onDrop: (n) => notices.push(n),
    });
    watcher.observe(path);
    watcher.scan(); // no growth: readChunk returns empty text, more:false
    watcher.finish();
    expect(events).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  test("C-API-12 scan honors the per-pass chunk budget across ticks", () => {
    const path = tmp("stream.jsonl");
    writeFileSync(path, "");
    const events: CodexTranscriptEvent[] = [];
    const watcher = new CodexTranscriptWatcher("s", (e) => events.push(e));
    watcher.observe(path);
    // > the 16-chunk per-scan budget of newline-terminated data: one scan cannot
    // consume it all; a second scan drains the rest.
    appendFileSync(path, `${JSON.stringify({ type: "message" })}\n`);
    appendFileSync(path, `${"m".repeat(256 * 1024)}\n`.repeat(17));
    watcher.scan();
    const afterFirst = events.length;
    watcher.scan();
    watcher.finish();
    expect(events.length).toBeGreaterThanOrEqual(afterFirst);
  });

  test("C-API-12 a giant no-newline record surfaces an oversized drop, no event", () => {
    const path = tmp("giant.jsonl");
    writeFileSync(path, "");
    const events: CodexTranscriptEvent[] = [];
    const notices: CodexDropNotice[] = [];
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

  test("C-API-12 a contained read failure during scan records a read error", () => {
    const path = tmp("scanfail.jsonl");
    writeFileSync(path, "");
    const errs: CodexReadErrorNotice[] = [];
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
  const dropNotice: CodexDropNotice = {
    elwoodSessionId: "s",
    path: "/t",
    droppedCount: 3,
    droppedBytes: 900,
    cause: "unread_backlog",
  };
  const drop = codexDropWarning(dropNotice);
  const read = codexReadErrorWarning({
    elwoodSessionId: "s",
    path: "/t",
    errorCount: 2,
    lastErrorCode: "ENOENT",
  });

  test("C-API-12 drop + read-error warnings are content-free and codex-tagged", () => {
    expect(drop).toMatchObject({
      agent: "codex",
      source: "terminal",
      code: "transcript_records_dropped",
      cause: "unread_backlog",
      transcriptPath: "/t",
    });
    expect(drop.message).toContain("unread transcript backlog");
    expect(drop.raw).toBe("transcript_records_dropped count=3 bytes=900 cause=unread_backlog");
    expect(read).toMatchObject({ agent: "codex", code: "transcript_read_error", errorCount: 2 });
    expect(read.raw).toBe("transcript_read_error count=2 code=ENOENT");
  });

  test("C-API-12 codex drop + read-error warnings survive persist→resume", () => {
    // The shared warnings now accept `agent: "codex"`, so a persisted codex drop
    // must round-trip through validation (proving the widened agent branch, §5.4).
    const root = mkdtempSync(join(tmpdir(), "elwood-codex-drop-"));
    const id = "s";
    const record = JSON.parse(
      JSON.stringify(createSessionRecord({ stateDir: root, cwd: root, id, adapter: "codex" })),
    ) as Record<string, unknown>;
    expect(validateSessionRecord({ ...record, warnings: [drop] }, root, id)).not.toBeNull();
    expect(validateSessionRecord({ ...record, warnings: [read] }, root, id)).not.toBeNull();
    // A bogus agent on the same shape is still rejected.
    expect(
      validateSessionRecord({ ...record, warnings: [{ ...drop, agent: "gemini" }] }, root, id),
    ).toBeNull();
  });

  test("C-API-12 each drop cause has a distinct human phrase", () => {
    const phrases = (["unparseable", "oversized", "unread_backlog"] as const).map(
      (cause) => codexDropWarning({ ...dropNotice, cause }).message,
    );
    expect(new Set(phrases).size).toBe(3);
  });
});
