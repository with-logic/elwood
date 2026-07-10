/**
 * Lifecycle coverage for the Claude transcript watcher: finish() as a terminal
 * state, subagent retirement, over-length record discard, and the timer poll's
 * error boundary. Covers PRD §5.4/§9.2 (C-CLAUDE-15).
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

describe("C-CLAUDE-15 Claude transcript watcher lifecycle", () => {
  test("finish() is terminal: a later observe/scan/poll emits nothing", async () => {
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeRecords(path);
    watcher.observe(path);
    watcher.finish();
    // After finish, nothing may emit past terminal:exit — observe/scan/poll no-op.
    appendRecords(path, [], assistant("after-finish"));
    watcher.observe(path);
    watcher.scan();
    await watcher.pollOnceForTests();
    expect(events).toEqual([]);
  });

  test("finish() drains a multi-chunk delta fully (more=true loops to EOF)", () => {
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeRecords(path);
    watcher.observe(path);
    // Append > 256 KiB of valid records so finish()'s drain loops (chunk.more)
    // across multiple readChunk passes rather than stopping after one.
    const many = Array.from({ length: 4000 }, (_, i) => assistant(`m${i}`));
    appendRecords(path, [], ...many);
    watcher.finish();
    expect(events).toHaveLength(4000);
    expect(texts(events).at(-1)).toBe("m3999");
  });

  test("retire flushes and drops a stopped subagent cursor from active polling", () => {
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeRecords(path);
    watcher.observe(path);
    appendRecords(path, [], assistant("sub-final"));
    watcher.retire(path); // flush the subagent's final record, then stop polling it
    expect(texts(events)).toEqual(["sub-final"]);
    // Retired: further appends are no longer observed by a scan.
    appendRecords(path, [assistant("sub-final")], assistant("ignored"));
    watcher.scan();
    expect(texts(events)).toEqual(["sub-final"]);
    watcher.stop();
  });

  test("retire after finish is a no-op; an over-length record drops through the watcher", () => {
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e), {
      onDrop: (d) => drops.push(d),
    });
    writeRecords(path);
    watcher.observe(path);
    // A >1 MiB run with NO newline overflows the pending buffer, so the watcher's
    // emit pipeline discards it (covers the droppedBytes route). The trailing
    // newline + real record then emits normally after the discarded line ends.
    const huge = "y".repeat(1024 * 1024 + 512 * 1024); // 1.5 MiB, no newline
    writeFileSync(path, huge);
    watcher.scan();
    expect(events).toEqual([]); // nothing complete yet; the over-length line dropped
    expect(drops.at(-1)!.droppedBytes).toBeGreaterThan(1024 * 1024);
    // Append the record after the huge line WITHOUT truncating (grow the file).
    writeFileSync(path, `${huge}\n${JSON.stringify(assistant("ok"))}\n`);
    watcher.finish();
    expect(texts(events)).toEqual(["ok"]);
    // Retire after finish is a no-op (finished guard).
    expect(() => watcher.retire(path)).not.toThrow();
  });

  test("a poll in flight when finish() runs bails after its await (no post-exit emit)", async () => {
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeRecords(path);
    watcher.observe(path);
    appendRecords(path, [], assistant("racing"));
    // Start a poll (it awaits the async stat), then finish() before it resolves.
    // finish() drains "racing" once; the in-flight poll must bail after its await
    // so the record is NOT emitted a SECOND time past terminal:exit.
    const inFlight = watcher.pollOnceForTests();
    watcher.finish();
    await inFlight;
    expect(texts(events)).toEqual(["racing"]); // exactly once, from finish's drain
  });

  test("a scan fs error during the final drain is contained", () => {
    const path = tmpFile();
    const watcher = new ClaudeTranscriptWatcher("s1", () => {});
    writeRecords(path);
    watcher.observe(path);
    appendRecords(path, [], assistant("x"));
    rmSync(path);
    mkdirSync(path); // the drain read now throws EISDIR: finish() must contain it
    expect(() => watcher.finish()).not.toThrow();
  });

  test("a synchronous listener error on the timer path stops the watcher via onPollError", async () => {
    const path = tmpFile();
    const errors: unknown[] = [];
    const watcher = new ClaudeTranscriptWatcher(
      "s1",
      () => {
        throw new Error("listener bug");
      },
      { onPollError: (e) => errors.push(e) },
    );
    writeRecords(path);
    watcher.observe(path);
    appendRecords(path, [], assistant("boom"));
    // The interval boundary catches the thrown listener error, finishes the
    // watcher, and routes the failure — never an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("listener bug");
    watcher.stop();
  });
});
