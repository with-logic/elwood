/**
 * Recovery/concurrency coverage for the Claude transcript watcher: the poll's
 * non-throwing recovery boundary and the retire-during-poll race.
 * Covers PRD §5.4/§9.2 (C-CLAUDE-15): a listener bug on the timer path can never
 * become a host-terminating unhandled rejection, and a cursor retired mid-poll is
 * not re-scanned past its one-shot retirement boundary.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  type ClaudeTranscriptEvent,
  ClaudeTranscriptWatcher,
} from "../../src/claude/transcript/index.ts";

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

describe("C-CLAUDE-15 transcript watcher recovery + retire race", () => {
  test("recovery's finish() re-throwing mid-drain still clears the timer and routes", async () => {
    // The poll scans cursor A and throws in the listener; recovery calls finish(),
    // which drains the still-unread cursor B and throws AGAIN. That second throw must
    // be contained (the timer still cleared via stop()) and the failure still routed.
    const a = tmpFile();
    const b = tmpFile();
    const errors: unknown[] = [];
    const watcher = new ClaudeTranscriptWatcher(
      "s1",
      () => {
        throw new Error("listener bug");
      },
      // Short poll cadence + waitFor so the assertion is deterministic, not a
      // fixed sleep racing the production 500 ms interval.
      { onPollError: (e) => errors.push(e), pollIntervalMs: 5 },
    );
    writeRecords(a);
    writeRecords(b);
    watcher.observe(a);
    watcher.observe(b);
    // Both cursors have an unread record. The poll throws on A; finish() then throws
    // again on B — exercising the stop() fallback when recovery's finish() re-throws.
    appendRecords(a, [], assistant("a-boom"));
    appendRecords(b, [], assistant("b-boom"));
    await vi.waitFor(() => expect(errors).toHaveLength(1)); // the failure was routed once
    watcher.stop();
  });

  test("a throwing onPollError diagnostic is swallowed (recovery never re-rejects)", async () => {
    // Both the activity listener AND the onPollError diagnostic throw. The recovery
    // boundary must contain the diagnostic throw too, so the timer callback's
    // promise chain still settles rather than becoming an unhandled rejection.
    const path = tmpFile();
    let pollErrorSeen = false;
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    const watcher = new ClaudeTranscriptWatcher(
      "s1",
      () => {
        throw new Error("listener bug");
      },
      {
        onPollError: () => {
          pollErrorSeen = true;
          throw new Error("diagnostic bug"); // the recovery must swallow this
        },
        pollIntervalMs: 5,
      },
    );
    writeRecords(path);
    watcher.observe(path);
    appendRecords(path, [], assistant("boom"));
    await vi.waitFor(() => expect(pollErrorSeen).toBe(true));
    // Give any (incorrectly) escaped rejection a macrotask to surface.
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.off("unhandledRejection", onRejection);
    watcher.stop();
    expect(pollErrorSeen).toBe(true);
    expect(rejections).toEqual([]); // the diagnostic throw did not escape the chain
  });

  test("retire during a poll's async stat does not re-scan the removed cursor", async () => {
    // Finding 10: poll() retains a cursor across the async needsScan() stat. If the
    // cursor is retired (drained + deleted) while the stat is in flight AND the file
    // then grows, the poll must NOT scan the stale cursor and emit past retirement.
    const path = tmpFile();
    const events: ClaudeTranscriptEvent[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", (e) => events.push(e));
    writeRecords(path);
    watcher.observe(path);
    appendRecords(path, [], assistant("before-retire"));
    // Start a poll (awaiting the async stat), then retire the cursor and grow the
    // file before the poll resolves. The stat reports growth, but the cursor is no
    // longer the active map entry, so the poll skips it.
    const inFlight = watcher.pollOnceForTests();
    watcher.retire(path); // drains "before-retire" once, deletes the cursor
    appendRecords(path, [assistant("before-retire")], assistant("after-retire"));
    await inFlight;
    watcher.stop();
    // "after-retire" was appended post-retirement: the stale cursor must not emit it.
    expect(texts(events)).toEqual(["before-retire"]);
  });
});
