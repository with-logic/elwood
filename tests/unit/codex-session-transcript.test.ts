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
  codexPollStoppedWarning: (_id: string, _e: unknown, phase = "poll") => ({
    code: "transcript_poll_stopped",
    phase,
  }),
}));

const { createCodexTranscriptWatcher } = await import("../../src/codex/session-transcript.ts");
const { TypedEmitter } = await import("../../src/events/emitter.ts");
type Sink = { emitWarnings: (w: readonly unknown[]) => void };

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
    const sink: Sink = { emitWarnings: (w) => recorded.push(...w) };
    createCodexTranscriptWatcher("s1", emitter(), () => sink as never);
    captured.onDrop?.(dropNotice);
    expect(recorded).toHaveLength(1);
  });

  test("§5.4 an ACTIVE sink that throws is contained; the live warning is dropped, not retried", () => {
    // Warnings are live-only: a throwing listener must be contained (route must not
    // throw into the watcher's scan) so the poll loop stays live, but the warning is
    // DROPPED — a human's terminal does not re-show a banner, so a later notice
    // delivers only ITSELF, never the earlier dropped one.
    let failNext = true;
    const recorded: unknown[] = [];
    const sink: Sink = {
      emitWarnings: (w) => {
        if (failNext) {
          failNext = false;
          throw new Error("listener boom");
        }
        recorded.push(...w);
      },
    };
    createCodexTranscriptWatcher("s1", emitter(), () => sink as never);
    expect(() => captured.onDrop?.(dropNotice)).not.toThrow(); // contained, not rethrown
    expect(recorded).toHaveLength(0); // the throwing delivery dropped its notice...
    captured.onReadError?.(readNotice); // ...and a later notice delivers ONLY itself
    expect(recorded).toHaveLength(1);
  });

  test("§9.4 routes a poll-stopped diagnostic to the sink", () => {
    const recorded: Array<{ code?: string }> = [];
    const sink: Sink = { emitWarnings: (w) => recorded.push(...(w as { code?: string }[])) };
    createCodexTranscriptWatcher("s1", emitter(), () => sink as never);
    captured.onPollError?.(new Error("boom"));
    expect(recorded).toEqual([{ code: "transcript_poll_stopped", phase: "poll" }]);
  });

  test("§5.7 buffers a notice seen before the sink exists, then flushes it with the next", () => {
    let sink: Sink | undefined;
    const recorded: unknown[] = [];
    createCodexTranscriptWatcher("s1", emitter(), () => sink as never);
    captured.onDrop?.(dropNotice); // no sink yet → buffered, not recorded
    expect(recorded).toHaveLength(0);
    sink = { emitWarnings: (w) => recorded.push(...w) };
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
    sink = { emitWarnings: (w) => recorded.push(...w) };
    // No second notice ever arrives; the explicit post-construction flush must
    // still persist the lone buffered notice (blocker: else it strands forever).
    flushPendingWarnings();
    expect(recorded).toHaveLength(1);
    flushPendingWarnings(); // idempotent: nothing left to flush
    expect(recorded).toHaveLength(1);
  });

  test("§5.4 a pre-sink notice is delivered once; if delivery throws it is dropped, not retried", () => {
    let sink: Sink | undefined; // no sink yet, so the notice buffers
    let failNext = true;
    const recorded: unknown[] = [];
    const { flushPendingWarnings } = createCodexTranscriptWatcher(
      "s1",
      emitter(),
      () => sink as never,
    );
    captured.onDrop?.(dropNotice); // buffered before the sink exists
    // The sink appears but its first emitWarnings throws.
    sink = {
      emitWarnings: (w) => {
        if (failNext) {
          failNext = false;
          throw new Error("listener boom");
        }
        recorded.push(...w);
      },
    };
    // flushPendingWarnings clears the batch FIRST, so it delivers once then throws
    // out of the listener; the notice is NOT retained.
    expect(() => flushPendingWarnings()).toThrow(/listener boom/);
    expect(recorded).toHaveLength(0);
    // A later flush has nothing queued — the earlier notice was dropped, not retried.
    flushPendingWarnings();
    expect(recorded).toHaveLength(0);
  });
});
