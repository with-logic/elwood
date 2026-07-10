/**
 * Focused coverage for the Claude transcript watcher and cursor.
 * Covers PRD §5.4 (C-CLAUDE-15): bounded, per-path, no-replay observation.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "elwood-tx-")), "t.jsonl");
}
const writeRecords = (path: string, ...records: unknown[]) =>
  writeFileSync(
    path,
    records.length ? `${records.map((r) => JSON.stringify(r)).join("\n")}\n` : "",
  );
const appendRecords = (path: string, prior: unknown[], ...records: unknown[]) =>
  writeRecords(path, ...prior, ...records);
const texts = (events: ClaudeTranscriptEvent[]) =>
  events.map((e) => (e.summary.kind === "assistant_message" ? e.summary.text : e.summary.kind));

describe("C-CLAUDE-15 Claude transcript watcher", () => {
  test("emits only NEW records appended after observe; does not replay history", () => {
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    // Pre-existing history — a new session must NOT re-emit this.
    writeRecords(path, assistant("old-1"), assistant("old-2"));
    watcher.observe(path);
    appendRecords(path, [assistant("old-1"), assistant("old-2")], assistant("new"));
    watcher.finish();
    expect(texts(events)).toEqual(["new"]);
  });

  const user = (text: string) => ({ type: "user", message: { content: text } });

  test("a turn-boundary first observe recovers ONLY the current assistant turn", () => {
    // The Stop-first edge: the committed turn is already on disk when observe
    // runs on a turn-boundary hook (recoverTail=true). Recovery is scoped to
    // records after the last user boundary, so the prior turn ("old") is not
    // replayed but the current one ("committed") is.
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeRecords(path, assistant("old"), user("go"), assistant("committed"));
    watcher.observe(path, true);
    watcher.finish();
    expect(texts(events)).toEqual(["committed"]);
  });

  test("a non-boundary first observe (resume) recovers NO history", () => {
    // SessionStart/resume: recoverTail defaults to false, so the already-on-disk
    // final turn is NOT republished. Only records appended AFTER observe emit.
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeRecords(path, assistant("old"), user("go"), assistant("committed"));
    watcher.observe(path); // no recoverTail: baseline at EOF
    appendRecords(path, [assistant("old"), user("go"), assistant("committed")], assistant("fresh"));
    watcher.finish();
    expect(texts(events)).toEqual(["fresh"]);
  });

  test("independent cursors per path: A→B→A does not replay A", () => {
    const a = tmpFile();
    const b = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeRecords(a);
    writeRecords(b);
    watcher.observe(a);
    appendRecords(a, [], assistant("a1"));
    watcher.scan();
    watcher.observe(b);
    appendRecords(b, [], assistant("b1"));
    watcher.observe(a); // re-observe A: must NOT reset its cursor or replay a1
    watcher.scan();
    watcher.finish();
    expect(texts(events)).toEqual(["a1", "b1"]);
  });

  test("scan/finish are safe (non-throwing) before observe and for a missing file", () => {
    const watcher = new ClaudeTranscriptWatcher("s1", () => {});
    expect(() => watcher.scan()).not.toThrow();
    watcher.observe(join(tmpdir(), "elwood-does-not-exist.jsonl"));
    expect(() => watcher.finish()).not.toThrow();
  });

  test("streams a large delta in bounded chunks (never buffers it whole)", () => {
    // 5000 small records force multiple readChunk() passes (256KB cap), covering
    // the bounded-drain loop that prevents an unbounded full-file allocation.
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeRecords(path);
    watcher.observe(path);
    const many = Array.from({ length: 5000 }, (_, i) => assistant(`m${i}`));
    appendRecords(path, [], ...many);
    watcher.scan();
    expect(events).toHaveLength(5000);
    expect(texts(events).at(-1)).toBe("m4999");
    watcher.stop();
  });

  test("a truncated/rotated file restarts the cursor rather than reading garbage", () => {
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeRecords(path);
    watcher.observe(path);
    appendRecords(path, [], assistant("aaaaa"), assistant("bbbbb"));
    watcher.scan();
    // Rewrite strictly shorter than the current offset: cursor rewinds to 0.
    writeRecords(path, assistant("c"));
    watcher.scan();
    expect(texts(events)).toEqual(["aaaaa", "bbbbb", "c"]);
    watcher.stop();
  });

  test("blank lines between records are skipped without a drop", () => {
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher(
      "s1",
      (e) => events.push(e),
      (d) => drops.push(d),
    );
    writeRecords(path);
    watcher.observe(path);
    writeFileSync(path, `${JSON.stringify(assistant("a"))}\n\n${JSON.stringify(assistant("b"))}\n`);
    watcher.finish();
    expect(texts(events)).toEqual(["a", "b"]);
    expect(drops).toEqual([]); // a blank line is not a dropped record
  });

  test("the poll interval emits without an explicit scan", async () => {
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeRecords(path);
    try {
      watcher.observe(path);
      appendRecords(path, [], assistant("polled"));
      await expect.poll(() => texts(events)).toEqual(["polled"]);
    } finally {
      watcher.stop();
    }
  });

  test("overlapping poll passes are guarded: the second is a no-op until the first ends", async () => {
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeRecords(path);
    watcher.observe(path);
    appendRecords(path, [], assistant("once"));
    // Fire two poll passes back-to-back: the second must observe `polling` and
    // return immediately, so the appended record is emitted exactly once.
    const first = watcher.pollOnceForTests();
    const second = watcher.pollOnceForTests();
    await Promise.all([first, second]);
    watcher.stop();
    expect(texts(events)).toEqual(["once"]);
  });

  test("an idle-poll stat race (file removed) is contained, not crashing the timer", async () => {
    // The async growth check must swallow a removal/rotation race so the shared
    // timer keeps running for every session instead of rejecting on a gone file.
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeRecords(path);
    watcher.observe(path);
    rmSync(path); // the file vanishes: the poll's async stat rejects
    await expect(watcher.pollOnceForTests()).resolves.toBeUndefined();
    expect(events).toEqual([]);
    watcher.stop();
  });
});
