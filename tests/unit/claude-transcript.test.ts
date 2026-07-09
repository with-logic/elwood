/**
 * Focused coverage for the Claude transcript reader and record summarizer.
 * Covers PRD §5.4 (C-CLAUDE-15).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createTranscriptWatcher, observeTranscript } from "../../src/claude/session-transcript.ts";
import {
  type ClaudeTranscriptEvent,
  ClaudeTranscriptWatcher,
} from "../../src/claude/transcript.ts";

describe("C-CLAUDE-15 Claude transcript watcher", () => {
  const write = (path: string, ...records: unknown[]) =>
    writeFileSync(
      path,
      records.length ? `${records.map((r) => JSON.stringify(r)).join("\n")}\n` : "",
    );

  test("emits items appended after observe and skips invalid JSON lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "elwood-tx-"));
    const path = join(dir, "t.jsonl");
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    // Observe an empty transcript first (as the session does on early hooks),
    // then let content be appended as the turn commits.
    write(path);
    watcher.observe(path);
    // A blank line (skipped) and a malformed line (parsed, yields no summary)
    // between two committed records exercise both emitLine guards.
    writeFileSync(
      path,
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "first" }] } })}\n\n{ not json }\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } })}\n`,
    );
    watcher.finish();
    expect(events.map((e) => e.summary.text)).toEqual(["first", "second"]);
    expect(events[0]!.elwoodSessionId).toBe("s1");
    expect(events[0]!.path).toBe(path);
  });

  test("observe resets on a new path and no-ops on the same path; scan tolerates truncation", () => {
    const dir = mkdtempSync(join(tmpdir(), "elwood-tx-"));
    const path = join(dir, "t.jsonl");
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    write(path); // observe empty, then append
    watcher.observe(path);
    watcher.observe(path); // same path: no reset
    write(
      path,
      { type: "assistant", message: { content: [{ type: "text", text: "aaaaa" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "bbbbb" }] } },
    );
    watcher.scan();
    expect(events.map((e) => e.summary.text)).toEqual(["aaaaa", "bbbbb"]);
    // Rewrite strictly shorter than the current offset: the watcher rewinds to 0
    // and re-reads rather than throwing or reading a torn tail.
    write(path, { type: "assistant", message: { content: [{ type: "text", text: "c" }] } });
    watcher.scan();
    expect(events.at(-1)!.summary.text).toBe("c");
  });

  test("observing a path that already holds the committed turn still emits it", () => {
    // The bug guard: if the first hook to carry transcript_path is Stop, the
    // committed assistant record is already on disk when observe() runs. Reading
    // from offset 0 (not end-of-file) ensures that turn is not skipped.
    const dir = mkdtempSync(join(tmpdir(), "elwood-tx-"));
    const path = join(dir, "t.jsonl");
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    write(path, { type: "assistant", message: { content: [{ type: "text", text: "committed" }] } });
    watcher.observe(path); // first observe AFTER the record is written
    watcher.scan();
    expect(events.map((e) => e.summary.text)).toEqual(["committed"]);
  });

  test("scan and finish are safe before any observe and for a missing file", () => {
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    expect(() => watcher.scan()).not.toThrow();
    watcher.observe(join(tmpdir(), "elwood-does-not-exist.jsonl"));
    expect(() => watcher.finish()).not.toThrow();
    expect(events).toEqual([]);
  });

  test("finish flushes a trailing record with no final newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "elwood-tx-"));
    const path = join(dir, "t.jsonl");
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    write(path);
    watcher.observe(path);
    // No trailing newline: the record sits in `pending` until finish flushes it.
    writeFileSync(
      path,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "tail" }] } }),
    );
    watcher.finish();
    expect(events.map((e) => e.summary.text)).toEqual(["tail"]);
  });

  test("the poll interval emits committed items without an explicit scan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elwood-tx-"));
    const path = join(dir, "t.jsonl");
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    try {
      watcher.observe(path);
      write(path, { type: "assistant", message: { content: [{ type: "text", text: "polled" }] } });
      // Poll the outcome rather than sleeping a fixed span past the 250ms tick.
      await expect.poll(() => events.map((e) => e.summary.text)).toEqual(["polled"]);
    } finally {
      watcher.stop();
    }
  });
});

describe("C-CLAUDE-15 transcript session wiring", () => {
  test("observeTranscript follows transcript_path and agent_transcript_path", () => {
    const observed: string[] = [];
    const watcher = { observe: (p: string) => observed.push(p) } as never;
    observeTranscript(watcher, { transcript_path: "/a.jsonl" });
    observeTranscript(watcher, { agent_transcript_path: "/b.jsonl" });
    observeTranscript(watcher, {}); // no path: ignored
    observeTranscript(watcher, { transcript_path: "" }); // empty: ignored
    expect(observed).toEqual(["/a.jsonl", "/b.jsonl"]);
  });

  test("createTranscriptWatcher emits transcript activities onto the emitter", () => {
    const activities: unknown[] = [];
    const emitter = { emit: (_e: string, a: unknown) => activities.push(a) } as never;
    const watcher = createTranscriptWatcher("s9", emitter);
    const dir = mkdtempSync(join(tmpdir(), "elwood-tx-"));
    const path = join(dir, "t.jsonl");
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "wired" }] } })}\n`,
    );
    watcher.scan();
    expect(activities).toEqual([
      expect.objectContaining({ agent: "claude", source: "transcript", kind: "assistant_message" }),
    ]);
  });
});
