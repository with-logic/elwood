/**
 * Coverage for createCodexTranscriptWatcher against the REAL bounded watcher on a
 * temp transcript (PRD §5.4/§5.7/§9.2, C-LIFE-10): records become `codex:transcript`
 * + `activity`; drop/read-error/poll-stopped notices route to the warning sink; a
 * pre-sink notice is buffered and flushed once (never retried after a throwing
 * delivery). finishSafely is covered by codex-session-transcript-finish.test.ts.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createCodexTranscriptWatcher } from "../../src/codex/session/transcript.ts";
import type { CodexEventMap } from "../../src/codex/session/types.ts";
import {
  resetByteReaderForTests,
  setByteReaderForTests,
} from "../../src/core/transcript/cursor-io.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { tempDirForUnit } from "./helpers.ts";

type Sink = { emitWarnings: (w: readonly ElwoodWarningEvent[]) => void };

afterEach(() => {
  vi.useRealTimers();
  resetByteReaderForTests();
});

/** Give the cursor pending bytes, then make every read fail with a directory errno. */
function failNextRead(path: string): void {
  appendFileSync(path, `${record}\n`);
  setByteReaderForTests(() => {
    throw Object.assign(new Error("EISDIR: illegal operation on a directory"), { code: "EISDIR" });
  });
}

/** A wired watcher already observing an empty temp transcript at `path`. */
function wired(getSink: () => Sink | undefined) {
  const emitter = new TypedEmitter<CodexEventMap>();
  const built = createCodexTranscriptWatcher("s1", emitter, getSink);
  const path = join(tempDirForUnit(), "rollout.jsonl");
  writeFileSync(path, "");
  built.watcher.observe(path);
  return { ...built, emitter, path };
}

/** A sink whose FIRST delivery throws (a listener bug) and which records the rest. */
function flakySink(recorded: ElwoodWarningEvent[]): Sink {
  let failNext = true;
  return {
    emitWarnings: (w) => {
      if (!failNext) return void recorded.push(...w);
      failNext = false;
      throw new Error("listener boom");
    },
  };
}
const recordingSink = (recorded: ElwoodWarningEvent[]): Sink => ({
  emitWarnings: (w) => recorded.push(...w),
});

const record = JSON.stringify({ type: "response_item", payload: { type: "reasoning" } });

describe("createCodexTranscriptWatcher (§5.4/§5.7)", () => {
  test("§5.4 a committed record is emitted as codex:transcript AND activity", () => {
    const kinds: string[] = [];
    const { watcher, emitter, path } = wired(() => undefined);
    emitter.on("codex:transcript", (event) => kinds.push(`transcript:${event.summary.kind}`));
    emitter.on("activity", (event) => kinds.push(`activity:${event.kind}`));
    writeFileSync(path, `${record}\n`);
    watcher.scan();
    expect(kinds).toEqual(["transcript:reasoning", "activity:reasoning"]);
  });

  test("§5.4 routes a drop notice straight to an available sink as a content-free warning", () => {
    const recorded: ElwoodWarningEvent[] = [];
    const { watcher, path } = wired(() => recordingSink(recorded));
    writeFileSync(path, "{ bad }\n");
    watcher.scan();
    expect(recorded).toMatchObject([
      {
        code: "transcript_records_dropped",
        agent: "codex",
        transcriptPath: path,
        cause: "unparseable",
      },
    ]);
    expect(JSON.stringify(recorded)).not.toContain("bad }");
  });

  test("§5.4 an ACTIVE sink that throws is contained; the live warning is dropped, not retried", () => {
    // Live-only: a throwing listener is contained (scan must not throw) but its
    // warning is DROPPED, so a later notice delivers only ITSELF.
    const recorded: ElwoodWarningEvent[] = [];
    const sink = flakySink(recorded);
    const { watcher, path } = wired(() => sink);
    writeFileSync(path, "{ bad }\n");
    expect(() => watcher.scan()).not.toThrow(); // contained, not rethrown
    expect(recorded).toEqual([]); // the throwing delivery dropped its notice...
    failNextRead(path); // ...and a later read-error notice delivers ONLY itself
    watcher.scan();
    expect(recorded).toMatchObject([
      { code: "transcript_read_error", transcriptPath: path, lastErrorCode: "EISDIR" },
    ]);
  });

  test("§9.4 a scan that throws on the timer routes a poll-stopped diagnostic to the sink", () => {
    vi.useFakeTimers();
    const recorded: ElwoodWarningEvent[] = [];
    const { watcher, path } = wired(() => recordingSink(recorded));
    vi.spyOn(watcher, "scan").mockImplementation(() => {
      throw new Error("internal scan boom");
    });
    writeFileSync(path, `${record}\n`);
    expect(() => vi.advanceTimersByTime(250)).not.toThrow(); // one poll tick, contained
    expect(recorded).toMatchObject([{ code: "transcript_poll_stopped", phase: "poll" }]);
    expect(JSON.stringify(recorded)).not.toContain("internal scan boom");
  });

  test("§5.7 buffers a notice seen before the sink exists, then flushes it with the next", () => {
    let sink: Sink | undefined;
    const recorded: ElwoodWarningEvent[] = [];
    const { watcher, path } = wired(() => sink);
    writeFileSync(path, "{ bad }\n");
    watcher.scan(); // no sink yet → buffered, not recorded
    expect(recorded).toEqual([]);
    sink = recordingSink(recorded);
    failNextRead(path);
    watcher.scan(); // a read error: flushes the buffered drop + records this
    expect(recorded.map((w) => w.code)).toEqual([
      "transcript_records_dropped",
      "transcript_read_error",
    ]);
  });

  test("§5.4 flushPendingWarnings delivers a LONE early notice with no follow-up", () => {
    let sink: Sink | undefined;
    const recorded: ElwoodWarningEvent[] = [];
    const { watcher, flushPendingWarnings, path } = wired(() => sink);
    writeFileSync(path, "{ bad }\n");
    watcher.scan(); // buffered before the sink exists
    sink = recordingSink(recorded);
    // No second notice ever arrives; the explicit post-construction flush must still
    // deliver the lone buffered notice, else it would strand forever.
    flushPendingWarnings();
    expect(recorded).toMatchObject([{ code: "transcript_records_dropped", transcriptPath: path }]);
    flushPendingWarnings(); // idempotent: nothing left to flush
    expect(recorded).toHaveLength(1);
  });

  test("§5.4 a pre-sink notice is delivered once; if delivery throws it is dropped, not retried", () => {
    let sink: Sink | undefined; // no sink yet, so the notice buffers
    const recorded: ElwoodWarningEvent[] = [];
    const { watcher, flushPendingWarnings, path } = wired(() => sink);
    writeFileSync(path, "{ bad }\n");
    watcher.scan();
    sink = flakySink(recorded); // the sink appears but its first emitWarnings throws
    // flushPendingWarnings clears the batch FIRST, so it delivers once then throws
    // out of the listener; the notice is NOT retained.
    expect(() => flushPendingWarnings()).toThrow(/listener boom/);
    expect(recorded).toEqual([]);
    flushPendingWarnings(); // nothing queued — the earlier notice was dropped, not retried
    expect(recorded).toEqual([]);
  });

  test("§5.4 a PERSISTENTLY throwing listener is contained; dropped warnings never accumulate", () => {
    // Each undelivered warning is DROPPED (never buffered for retry), so a recovered
    // listener gets ONLY the current notice, not a backlog.
    let failing = true;
    const recorded: ElwoodWarningEvent[] = [];
    const sink: Sink = {
      emitWarnings: (w) => {
        if (failing) throw new Error("listener boom");
        recorded.push(...w);
      },
    };
    const { watcher, path } = wired(() => sink);
    for (let i = 0; i < 3; i++) {
      writeFileSync(path, `${"{ bad }\n".repeat(i + 1)}`);
      expect(() => watcher.scan()).not.toThrow();
    }
    failing = false;
    writeFileSync(path, `${"{ bad }\n".repeat(4)}`);
    watcher.scan(); // recover: delivers ONLY this scan's notice
    expect(recorded).toMatchObject([{ code: "transcript_records_dropped", cause: "unparseable" }]);
  });
});
