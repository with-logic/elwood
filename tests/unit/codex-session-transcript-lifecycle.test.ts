/**
 * Lifecycle coverage for createCodexTranscriptWatcher (PRD §5.4/§9.2, C-LIFE-10):
 * a persistently throwing warning listener is contained and its warnings are dropped
 * (live-only, never buffered for retry, so the pending buffer never grows), and
 * finishSafely contains a throwing FINAL flush so terminal:exit is never skipped.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CodexEventMap } from "../../src/codex/session-types.ts";
import type { CodexDropNotice, CodexReadErrorNotice } from "../../src/codex/transcript/drops.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

// Callbacks typed with the PRODUCTION notice shapes so field drift fails the compile.
type OnDrop = ((n: CodexDropNotice) => void) | undefined;
type OnReadError = ((n: CodexReadErrorNotice) => void) | undefined;
type OnPollError = ((e: unknown) => void) | undefined;
const captured: { onDrop: OnDrop; onReadError: OnReadError; onPollError: OnPollError } = {
  onDrop: undefined,
  onReadError: undefined,
  onPollError: undefined,
};
const finishControl = { throws: false };
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
    finish() {
      if (finishControl.throws) throw new Error("final flush boom");
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
const emitter = (): TypedEmitter<CodexEventMap> => new TypedEmitter<CodexEventMap>();
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

beforeEach(() => {
  captured.onDrop = undefined;
  captured.onReadError = undefined;
  captured.onPollError = undefined;
  finishControl.throws = false;
});

describe("createCodexTranscriptWatcher lifecycle", () => {
  test("§5.4 a PERSISTENTLY throwing listener is contained; dropped warnings never accumulate", () => {
    // Warnings are live-only. A listener that throws on every scan is CONTAINED (the
    // watcher never throws), and each undelivered warning is DROPPED — never buffered
    // for retry. So when the listener recovers it delivers ONLY the current notice,
    // not a backlog: the pending buffer can never grow under a persistent failure.
    let failing = true;
    const recorded: ElwoodWarningEvent[] = [];
    const sink: Sink = {
      emitWarnings: (w) => {
        if (failing) throw new Error("listener boom");
        recorded.push(...w);
      },
    };
    createCodexTranscriptWatcher("s1", emitter(), () => sink);
    for (let i = 0; i < 3; i++) expect(() => captured.onDrop?.(dropNotice)).not.toThrow();
    captured.onReadError?.(readNotice); // also dropped while failing
    failing = false;
    captured.onDrop?.(dropNotice); // recover: delivers ONLY this current notice
    expect(recorded).toHaveLength(1);
    expect(recorded.map((w) => w.code)).toEqual(["transcript_records_dropped"]);
  });

  test("C-LIFE-10 finishSafely runs afterFlush after a successful final flush", () => {
    const { finishSafely } = createCodexTranscriptWatcher("s1", emitter(), () => undefined);
    let afterRan = false;
    finishSafely(() => {
      afterRan = true;
    });
    expect(afterRan).toBe(true);
  });

  test("C-LIFE-10 a THROWING final flush still runs afterFlush + routes a final_flush diagnostic", () => {
    // The FINAL flush throws: afterFlush (terminal:exit) must STILL run + a phase diagnostic.
    finishControl.throws = true;
    const recorded: ElwoodWarningEvent[] = [];
    const sink: Sink = { emitWarnings: (w) => recorded.push(...w) };
    const { finishSafely } = createCodexTranscriptWatcher("s1", emitter(), () => sink);
    let afterRan = false;
    finishSafely(() => {
      afterRan = true;
    });
    expect(afterRan).toBe(true); // terminal:exit emission is NOT skipped
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ code: "transcript_poll_stopped", phase: "final_flush" });
  });

  test("C-LIFE-10 finishSafely with no afterFlush is a no-op default", () => {
    const { finishSafely } = createCodexTranscriptWatcher("s1", emitter(), () => undefined);
    expect(() => finishSafely()).not.toThrow();
  });
});
