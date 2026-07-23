/**
 * Coverage for createCodexTranscriptWatcher (PRD §5.4/§5.7): drop/read-error
 * notices route to the session warning sink, and notices observed BEFORE the sink
 * exists are buffered and flushed on the first available sink, never dropped.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CodexEventMap } from "../../src/codex/session-types.ts";
import type { CodexDropNotice, CodexReadErrorNotice } from "../../src/codex/transcript/drops.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

// Capture the notices the factory hands the watcher, so tests can fire them. The
// callbacks are typed with the PRODUCTION notice shapes so a drift in those fields
// fails the compile here rather than being papered over with `as never`.
type OnDrop = ((n: CodexDropNotice) => void) | undefined;
type OnReadError = ((n: CodexReadErrorNotice) => void) | undefined;
type OnPollError = ((e: unknown) => void) | undefined;
const captured: { onDrop: OnDrop; onReadError: OnReadError; onPollError: OnPollError } = {
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
        onDrop?: (n: CodexDropNotice) => void;
        onReadError?: (n: CodexReadErrorNotice) => void;
        onPollError?: (e: unknown) => void;
      } = {},
    ) {
      captured.onDrop = notices.onDrop;
      captured.onReadError = notices.onReadError;
      captured.onPollError = notices.onPollError;
    }
  },
  // Full production warning shapes (satisfies the public union) so a drift in
  // ElwoodWarningEvent breaks the compile here rather than slipping past a partial object.
  codexDropWarning: (n: CodexDropNotice) =>
    ({
      elwoodSessionId: n.elwoodSessionId,
      agent: "codex",
      source: "terminal",
      code: "transcript_records_dropped",
      severity: "warning",
      message: "dropped",
      transcriptPath: n.path,
      cause: n.cause,
      raw: "drop",
    }) satisfies Extract<ElwoodWarningEvent, { code: "transcript_records_dropped" }>,
  codexReadErrorWarning: (n: CodexReadErrorNotice) =>
    ({
      elwoodSessionId: n.elwoodSessionId,
      agent: "codex",
      source: "terminal",
      code: "transcript_read_error",
      severity: "warning",
      message: "read error",
      transcriptPath: n.path,
      lastErrorCode: n.lastErrorCode,
      raw: "read",
    }) satisfies Extract<ElwoodWarningEvent, { code: "transcript_read_error" }>,
  codexPollStoppedWarning: (id: string, _e: unknown, phase: "poll" | "final_flush" = "poll") =>
    ({
      elwoodSessionId: id,
      agent: "codex",
      source: "terminal",
      code: "transcript_poll_stopped",
      severity: "warning",
      message: "poll stopped",
      reason: "UnknownError",
      phase,
      raw: "poll",
    }) satisfies Extract<ElwoodWarningEvent, { code: "transcript_poll_stopped" }>,
}));

const { createCodexTranscriptWatcher } = await import("../../src/codex/session-transcript.ts");
type Sink = { emitWarnings: (w: readonly ElwoodWarningEvent[]) => void };

function emitter(): TypedEmitter<CodexEventMap> {
  return new TypedEmitter<CodexEventMap>();
}

beforeEach(() => {
  captured.onDrop = undefined;
  captured.onReadError = undefined;
  captured.onPollError = undefined;
});

// Real, count-free production notices (path/cause and path/last-error-code).
const dropNotice = {
  elwoodSessionId: "s1",
  path: "/t/rollout.jsonl",
  cause: "unparseable",
} satisfies CodexDropNotice;
const readNotice = {
  elwoodSessionId: "s1",
  path: "/t/rollout.jsonl",
  lastErrorCode: "EISDIR",
} satisfies CodexReadErrorNotice;

describe("createCodexTranscriptWatcher (§5.4/§5.7)", () => {
  test("§5.4 routes a drop notice straight to an available sink", () => {
    const recorded: ElwoodWarningEvent[] = [];
    const sink: Sink = { emitWarnings: (w) => recorded.push(...w) };
    createCodexTranscriptWatcher("s1", emitter(), () => sink);
    captured.onDrop?.(dropNotice);
    expect(recorded).toHaveLength(1);
  });

  test("§5.4 an ACTIVE sink that throws is contained; the live warning is dropped, not retried", () => {
    // Warnings are live-only: a throwing listener must be contained (route must not
    // throw into the watcher's scan) so the poll loop stays live, but the warning is
    // DROPPED — a human's terminal does not re-show a banner, so a later notice
    // delivers only ITSELF, never the earlier dropped one.
    let failNext = true;
    const recorded: ElwoodWarningEvent[] = [];
    const sink: Sink = {
      emitWarnings: (w) => {
        if (failNext) {
          failNext = false;
          throw new Error("listener boom");
        }
        recorded.push(...w);
      },
    };
    createCodexTranscriptWatcher("s1", emitter(), () => sink);
    expect(() => captured.onDrop?.(dropNotice)).not.toThrow(); // contained, not rethrown
    expect(recorded).toHaveLength(0); // the throwing delivery dropped its notice...
    captured.onReadError?.(readNotice); // ...and a later notice delivers ONLY itself
    expect(recorded).toHaveLength(1);
  });

  test("§9.4 routes a poll-stopped diagnostic to the sink", () => {
    const recorded: ElwoodWarningEvent[] = [];
    const sink: Sink = { emitWarnings: (w) => recorded.push(...w) };
    createCodexTranscriptWatcher("s1", emitter(), () => sink);
    captured.onPollError?.(new Error("boom"));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ code: "transcript_poll_stopped", phase: "poll" });
  });

  test("§5.7 buffers a notice seen before the sink exists, then flushes it with the next", () => {
    let sink: Sink | undefined;
    const recorded: ElwoodWarningEvent[] = [];
    createCodexTranscriptWatcher("s1", emitter(), () => sink);
    captured.onDrop?.(dropNotice); // no sink yet → buffered, not recorded
    expect(recorded).toHaveLength(0);
    sink = { emitWarnings: (w) => recorded.push(...w) };
    captured.onReadError?.(readNotice); // flushes the buffered drop + records this
    expect(recorded).toHaveLength(2);
  });

  test("§5.4 flushPendingWarnings delivers a LONE early notice with no follow-up", () => {
    let sink: Sink | undefined;
    const recorded: ElwoodWarningEvent[] = [];
    const { flushPendingWarnings } = createCodexTranscriptWatcher("s1", emitter(), () => sink);
    captured.onDrop?.(dropNotice); // buffered before the sink exists
    sink = { emitWarnings: (w) => recorded.push(...w) };
    // No second notice ever arrives; the explicit post-construction flush must
    // still deliver the lone buffered notice (blocker: else it strands forever).
    flushPendingWarnings();
    expect(recorded).toHaveLength(1);
    flushPendingWarnings(); // idempotent: nothing left to flush
    expect(recorded).toHaveLength(1);
  });

  test("§5.4 a pre-sink notice is delivered once; if delivery throws it is dropped, not retried", () => {
    let sink: Sink | undefined; // no sink yet, so the notice buffers
    let failNext = true;
    const recorded: ElwoodWarningEvent[] = [];
    const { flushPendingWarnings } = createCodexTranscriptWatcher("s1", emitter(), () => sink);
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
