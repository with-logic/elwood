/**
 * Lifecycle coverage for createCodexTranscriptWatcher (PRD §5.4/§9.2, C-LIFE-10):
 * a persistently throwing warning listener is contained and its warnings are dropped
 * (live-only, never buffered for retry, so the pending buffer never grows), and
 * finishSafely contains a throwing FINAL flush so terminal:exit is never skipped.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

type Notice = ((n: unknown) => void) | undefined;
const captured: { onDrop: Notice; onReadError: Notice; onPollError: Notice } = {
  onDrop: undefined,
  onReadError: undefined,
  onPollError: undefined,
};
const finishControl = { throws: false };
vi.mock("../../src/codex/transcript.ts", () => ({
  CodexTranscriptWatcher: class {
    constructor(_id: string, _emit: unknown, notices: Record<string, (n: unknown) => void> = {}) {
      captured.onDrop = notices["onDrop"];
      captured.onReadError = notices["onReadError"];
      captured.onPollError = notices["onPollError"];
    }
    finish() {
      if (finishControl.throws) throw new Error("final flush boom");
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
type Sink = { recordWarnings: (w: readonly unknown[]) => void };
const emitter = () => new TypedEmitter() as never;
const dropNotice = { elwoodSessionId: "s1", count: 1 } as never;
const readNotice = { elwoodSessionId: "s1", count: 1 } as never;

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
    const recorded: unknown[] = [];
    const sink: Sink = {
      recordWarnings: (w) => {
        if (failing) throw new Error("listener boom");
        recorded.push(...w);
      },
    };
    createCodexTranscriptWatcher("s1", emitter(), () => sink as never);
    for (let i = 0; i < 3; i++) expect(() => captured.onDrop?.(dropNotice)).not.toThrow();
    captured.onReadError?.(readNotice); // also dropped while failing
    failing = false;
    captured.onDrop?.(dropNotice); // recover: delivers ONLY this current notice
    expect(recorded).toHaveLength(1);
    expect((recorded as Array<{ code: string }>).map((w) => w.code)).toEqual([
      "transcript_records_dropped",
    ]);
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
    const recorded: Array<{ code?: string; phase?: string }> = [];
    const sink: Sink = { recordWarnings: (w) => recorded.push(...(w as never[])) };
    const { finishSafely } = createCodexTranscriptWatcher("s1", emitter(), () => sink as never);
    let afterRan = false;
    finishSafely(() => {
      afterRan = true;
    });
    expect(afterRan).toBe(true); // terminal:exit emission is NOT skipped
    expect(recorded).toEqual([{ code: "transcript_poll_stopped", phase: "final_flush" }]);
  });

  test("C-LIFE-10 finishSafely with no afterFlush is a no-op default", () => {
    const { finishSafely } = createCodexTranscriptWatcher("s1", emitter(), () => undefined);
    expect(() => finishSafely()).not.toThrow();
  });
});
