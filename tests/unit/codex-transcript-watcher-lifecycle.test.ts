/**
 * Lifecycle robustness for the bounded Codex transcript watcher (PRD §5.4/§9.4): a
 * throwing scan is contained (the watcher stops itself and routes a content-free
 * `transcript_poll_stopped` diagnostic instead of crashing the host), `finish()` is
 * terminal and idempotent, and a late `observe()` never restarts polling past exit.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { codexPollStoppedWarning } from "../../src/codex/transcript/warnings.ts";
import { CodexTranscriptWatcher } from "../../src/codex/transcript/watcher.ts";
import { resetByteReaderForTests } from "../../src/core/transcript/cursor-io.ts";
import { tempDirForUnit } from "./helpers.ts";

afterEach(() => {
  resetByteReaderForTests();
  vi.useRealTimers();
});

function tmp(): string {
  return join(tempDirForUnit(), "codex.jsonl");
}

const record = () => `${JSON.stringify({ type: "message" })}\n`;

describe("Codex transcript watcher lifecycle (§5.4/§9.4)", () => {
  test("§9.4 a throwing scan on the timer is contained and routes a diagnostic", () => {
    vi.useFakeTimers();
    const pollErrors: unknown[] = [];
    const path = tmp();
    // An oversized record fires onDrop inside scan(); a throwing onDrop makes scan()
    // throw from the interval callback — the timer must contain it, stop, and route
    // onPollError rather than surfacing an uncaught exception. Content is appended
    // AFTER observe (which baselines at the current end and never replays history).
    writeFileSync(path, "");
    const watcher = new CodexTranscriptWatcher("s", () => undefined, {
      scanIntervalMs: 1,
      onDrop: () => {
        throw new Error("timer boom");
      },
      onPollError: (e) => pollErrors.push(e),
    });
    watcher.observe(path);
    appendFileSync(path, "g".repeat(1024 * 1024 + 50));
    expect(() => vi.advanceTimersByTime(5)).not.toThrow(); // contained, no host crash
    expect(pollErrors.length).toBe(1); // diagnostic routed exactly once
    // The watcher stopped itself: further ticks fire no more scans.
    expect(() => vi.advanceTimersByTime(20)).not.toThrow();
    expect(pollErrors.length).toBe(1);
  });

  test("§5.4 finish() is idempotent and terminal — a second finish/observe is a no-op", () => {
    const path = tmp();
    writeFileSync(path, record());
    const events: unknown[] = [];
    const watcher = new CodexTranscriptWatcher("s", (e) => events.push(e), { scanIntervalMs: 5 });
    watcher.observe(path);
    watcher.finish();
    const afterFirstFinish = events.length;
    watcher.finish(); // idempotent: no re-drain, no throw
    // A late observe must NOT restart polling past a terminal:exit.
    appendFileSync(path, record());
    watcher.observe(tmp());
    watcher.scan(); // finished → no-op
    expect(events.length).toBe(afterFirstFinish);
  });

  test("C-CODEX-20 §9.4 a throwing final drain still leaves the watcher terminal (timer cleared)", () => {
    const path = tmp();
    // Oversized record: the terminal drain in finish() reports it as a drop; a
    // throwing onDrop makes that drain throw. finish() must still latch `finished`
    // and clear the interval (stop() runs in `finally`), so it never leaks a timer.
    // Appended AFTER observe so the cursor actually sees it (observe baselines at end).
    writeFileSync(path, "");
    const watcher = new CodexTranscriptWatcher("s", () => undefined, {
      scanIntervalMs: 5,
      onDrop: () => {
        throw new Error("drain boom");
      },
    });
    watcher.observe(path);
    appendFileSync(path, "g".repeat(1024 * 1024 + 50));
    expect(() => watcher.finish()).toThrow(/drain boom/);
    // Terminal despite the throw: a late observe/scan is a no-op (no restart).
    watcher.observe(tmp());
    expect(() => watcher.scan()).not.toThrow();
  });

  test("§9.4 recovery still clears the timer when finish() ALSO throws mid-drain", () => {
    vi.useFakeTimers();
    const pollErrors: unknown[] = [];
    const path = tmp();
    writeFileSync(path, "");
    // A throwing emit fires on EVERY record: the scan emits+throws (→ recovery), and
    // recovery's finish() drains the still-unread records and emits+throws AGAIN — so
    // recovery's inner catch must still stop the timer, then route the diagnostic once.
    const watcher = new CodexTranscriptWatcher(
      "s",
      () => {
        throw new Error("always boom");
      },
      { scanIntervalMs: 1, onPollError: (e) => pollErrors.push(e) },
    );
    watcher.observe(path);
    // Many small records: the first scan reads some (emit throws), and finish()'s
    // drain reaches the rest (emit throws again in recovery).
    for (let i = 0; i < 40; i += 1) appendFileSync(path, record());
    expect(() => vi.advanceTimersByTime(5)).not.toThrow(); // both throws contained
    expect(pollErrors.length).toBe(1);
    expect(() => vi.advanceTimersByTime(20)).not.toThrow(); // timer was cleared
    expect(pollErrors.length).toBe(1);
  });

  test("C-CODEX-20 §5.4 codexPollStoppedWarning is content-free and codex-tagged", () => {
    // The escaping error's message may embed raw transcript content, so only an
    // allowlisted `reason` token survives — never error.message.
    const warning = codexPollStoppedWarning("s", new Error("secret prompt: hunter2"));
    expect(warning).toMatchObject({
      agent: "codex",
      code: "transcript_poll_stopped",
      phase: "poll",
    });
    expect(JSON.stringify(warning)).not.toContain("hunter2");
  });
});
