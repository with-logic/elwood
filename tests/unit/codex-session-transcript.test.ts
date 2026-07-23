/**
 * Coverage for createCodexTranscriptWatcher (PRD §5.4/§5.7): drop/read-error
 * notices route to the session warning sink, and notices observed BEFORE the sink
 * exists are buffered and flushed on the first available sink, never dropped.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

// Capture the notices the factory hands the watcher, so tests can fire them.
type Notice = ((n: unknown) => void) | undefined;
const captured: { onDrop: Notice; onReadError: Notice; onPollError: Notice } = {
  onDrop: undefined,
  onReadError: undefined,
  onPollError: undefined,
};
vi.mock("../../src/codex/transcript.ts", () => ({
  CodexTranscriptWatcher: class {
    constructor(
      _id: string,
      _emit: unknown,
      notices: {
        onDrop?: (n: unknown) => void;
        onReadError?: (n: unknown) => void;
        onPollError?: (n: unknown) => void;
      } = {},
    ) {
      captured.onDrop = notices.onDrop;
      captured.onReadError = notices.onReadError;
      captured.onPollError = notices.onPollError;
    }
  },
  codexDropWarning: (n: { count: number }) => ({ code: "transcript_records_dropped", ...n }),
  codexReadErrorWarning: (n: { count: number }) => ({ code: "transcript_read_error", ...n }),
  codexPollStoppedWarning: (_id: string, _e: unknown) => ({ code: "transcript_poll_stopped" }),
}));

const { createCodexTranscriptWatcher, codexTranscriptSeedFromWarnings } = await import(
  "../../src/codex/session-transcript.ts"
);
const { TypedEmitter } = await import("../../src/events/emitter.ts");
type Sink = { recordWarnings: (w: readonly unknown[]) => void };

function emitter() {
  return new TypedEmitter() as never;
}

beforeEach(() => {
  captured.onDrop = undefined;
  captured.onReadError = undefined;
  captured.onPollError = undefined;
});

const dropNotice = { elwoodSessionId: "s1", count: 1 } as never;
const readNotice = { elwoodSessionId: "s1", count: 1 } as never;

describe("createCodexTranscriptWatcher (§5.4/§5.7)", () => {
  test("§5.4 routes a drop notice straight to an available sink", () => {
    const recorded: unknown[] = [];
    const sink: Sink = { recordWarnings: (w) => recorded.push(...w) };
    createCodexTranscriptWatcher("s1", emitter(), () => sink as never);
    captured.onDrop?.(dropNotice);
    expect(recorded).toHaveLength(1);
  });

  test("§5.4 an ACTIVE sink that throws does not lose the notice OR escape the poll loop", () => {
    // The sink already exists (steady-state polling). A throwing recordWarnings must
    // be contained (route must not throw into the watcher's scan) AND the notice must
    // stay queued so the next event re-delivers it — the active-sink retry path.
    let failNext = true;
    const recorded: unknown[] = [];
    const sink: Sink = {
      recordWarnings: (w) => {
        if (failNext) {
          failNext = false;
          throw new Error("persist boom");
        }
        recorded.push(...w);
      },
    };
    createCodexTranscriptWatcher("s1", emitter(), () => sink as never);
    expect(() => captured.onDrop?.(dropNotice)).not.toThrow(); // contained, not rethrown
    expect(recorded).toHaveLength(0); // the throwing delivery recorded nothing...
    captured.onReadError?.(readNotice); // ...but a later event re-delivers BOTH notices
    expect(recorded).toHaveLength(2);
  });

  test("§9.4 routes a poll-stopped diagnostic to the sink", () => {
    const recorded: Array<{ code?: string }> = [];
    const sink: Sink = { recordWarnings: (w) => recorded.push(...(w as { code?: string }[])) };
    createCodexTranscriptWatcher("s1", emitter(), () => sink as never);
    captured.onPollError?.(new Error("boom"));
    expect(recorded).toEqual([{ code: "transcript_poll_stopped" }]);
  });

  test("§5.7 buffers a notice seen before the sink exists, then flushes it with the next", () => {
    let sink: Sink | undefined;
    const recorded: unknown[] = [];
    createCodexTranscriptWatcher("s1", emitter(), () => sink as never);
    captured.onDrop?.(dropNotice); // no sink yet → buffered, not recorded
    expect(recorded).toHaveLength(0);
    sink = { recordWarnings: (w) => recorded.push(...w) };
    captured.onReadError?.(readNotice); // flushes the buffered drop + records this
    expect(recorded).toHaveLength(2);
  });

  test("§5.4 flushPendingWarnings persists a LONE early notice with no follow-up", () => {
    let sink: Sink | undefined;
    const recorded: unknown[] = [];
    const { flushPendingWarnings } = createCodexTranscriptWatcher(
      "s1",
      emitter(),
      () => sink as never,
    );
    captured.onDrop?.(dropNotice); // buffered before the sink exists
    sink = { recordWarnings: (w) => recorded.push(...w) };
    // No second notice ever arrives; the explicit post-construction flush must
    // still persist the lone buffered notice (blocker: else it strands forever).
    flushPendingWarnings();
    expect(recorded).toHaveLength(1);
    flushPendingWarnings(); // idempotent: nothing left to flush
    expect(recorded).toHaveLength(1);
  });

  test("§5.4 a throwing recordWarnings does NOT lose the buffered notices — a retry re-delivers", () => {
    let sink: Sink | undefined; // no sink yet, so the notice buffers
    let failNext = true;
    const recorded: unknown[] = [];
    const { flushPendingWarnings } = createCodexTranscriptWatcher(
      "s1",
      emitter(),
      () => sink as never,
    );
    captured.onDrop?.(dropNotice); // buffered before the sink exists
    // The sink appears but its first recordWarnings throws.
    sink = {
      recordWarnings: (w) => {
        if (failNext) {
          failNext = false;
          throw new Error("persist boom");
        }
        recorded.push(...w);
      },
    };
    expect(() => flushPendingWarnings()).toThrow(/persist boom/);
    expect(recorded).toHaveLength(0);
    // The notice stayed queued: a later flush re-delivers it (not lost).
    flushPendingWarnings();
    expect(recorded).toHaveLength(1);
  });

  test("§5.4 codexTranscriptSeedFromWarnings recovers running totals so counts never restart at 0", () => {
    const seed = codexTranscriptSeedFromWarnings([
      { code: "transcript_records_dropped", droppedCount: 60, droppedBytes: 4096 },
      { code: "transcript_read_error", errorCount: 7 },
      { code: "login_expired" }, // unrelated warnings are ignored
    ] as never);
    expect(seed).toEqual({
      drops: { droppedCount: 60, droppedBytes: 4096 },
      readErrors: { errorCount: 7 },
    });
    // No transcript warnings → empty seed (a fresh session starts at 0).
    expect(codexTranscriptSeedFromWarnings([])).toEqual({});
  });
});
