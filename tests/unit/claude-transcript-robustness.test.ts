/**
 * Robustness of the Claude transcript watcher: contained fs errors, surfaced
 * programming errors, and bounded drop diagnostics. Covers PRD §5.4 (C-CLAUDE-15).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type ClaudeTranscriptEvent,
  ClaudeTranscriptWatcher,
  type TranscriptDropNotice,
} from "../../src/claude/transcript.ts";

const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "elwood-tx-")), "t.jsonl");
const record = (r: unknown) => `${JSON.stringify(r)}\n`;

describe("C-CLAUDE-15 transcript watcher robustness", () => {
  test("skips malformed JSON and reports a bounded drop diagnostic (no raw content)", () => {
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher(
      "s1",
      (e) => events.push(e),
      (d) => drops.push(d),
    );
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${record(assistant("ok"))}{ not json }\n`);
    watcher.finish();
    expect(
      events.map((e) => (e.summary.kind === "assistant_message" ? e.summary.text : "")),
    ).toEqual(["ok"]);
    // Bounded, content-free: count + byte magnitude, never the raw line.
    expect(drops).toEqual([{ elwoodSessionId: "s1", path, droppedCount: 1, droppedBytes: 12 }]);
  });

  test("a filesystem error during scan is contained (best-effort, non-throwing)", () => {
    // Replace the file with a directory: reads now throw a rotation-race-like
    // error that the fs guard must swallow without crashing the timer.
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeFileSync(path, "");
    watcher.observe(path);
    rmSync(path);
    mkdirSync(path); // reading a directory throws EISDIR
    expect(() => watcher.scan()).not.toThrow();
    expect(events).toEqual([]);
    watcher.stop();
  });

  test("a failing baseline read at observe is contained (no crash, no baseline)", () => {
    // The path is a directory, so the first-observe baseline read throws; observe
    // must contain it and emit nothing rather than propagate.
    const dir = mkdtempSync(join(tmpdir(), "elwood-tx-dir-"));
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    expect(() => watcher.observe(dir)).not.toThrow();
    expect(events).toEqual([]);
    watcher.stop();
  });

  test("a downstream emit/listener error is NOT swallowed by the fs guard", () => {
    // The guard contains only the filesystem read; a programming error in an
    // activity listener must surface, not be silently masked.
    const path = tmpFile();
    const watcher = new ClaudeTranscriptWatcher("s1", () => {
      throw new Error("listener bug");
    });
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, record(assistant("boom")));
    expect(() => watcher.scan()).toThrow("listener bug");
    watcher.stop();
  });

  test("drop notices are rate-bounded and content-free, not one-per-line", () => {
    const path = tmpFile();
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher(
      "s1",
      () => {},
      (d) => drops.push(d),
    );
    writeFileSync(path, "");
    watcher.observe(path);
    // 60 malformed lines: notify on the first, then at the 50-drop threshold, and
    // once more on finish — never 60 notices.
    writeFileSync(path, `${Array.from({ length: 60 }, () => "{ bad }").join("\n")}\n`);
    watcher.finish();
    expect(drops.length).toBeLessThan(60);
    expect(drops.at(-1)).toMatchObject({ droppedCount: 60 });
    expect(drops.at(-1)!.droppedBytes).toBeGreaterThan(0);
  });
});
