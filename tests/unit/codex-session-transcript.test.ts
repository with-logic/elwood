/**
 * Coverage for createCodexTranscriptWatcher (PRD §5.4/§5.7): drop/read-error
 * notices route to the session warning sink, and notices observed BEFORE the sink
 * exists are buffered and flushed on the first available sink, never dropped.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

// Capture the notices the factory hands the watcher, so tests can fire them.
type Notice = ((n: unknown) => void) | undefined;
const captured: { onDrop: Notice; onReadError: Notice } = {
  onDrop: undefined,
  onReadError: undefined,
};
vi.mock("../../src/codex/transcript.ts", () => ({
  CodexTranscriptWatcher: class {
    constructor(
      _id: string,
      _emit: unknown,
      notices: { onDrop?: (n: unknown) => void; onReadError?: (n: unknown) => void } = {},
    ) {
      captured.onDrop = notices.onDrop;
      captured.onReadError = notices.onReadError;
    }
  },
  codexDropWarning: (n: { count: number }) => ({ code: "transcript_records_dropped", ...n }),
  codexReadErrorWarning: (n: { count: number }) => ({ code: "transcript_read_error", ...n }),
}));

const { createCodexTranscriptWatcher } = await import("../../src/codex/session-transcript.ts");
const { TypedEmitter } = await import("../../src/events/emitter.ts");
type Sink = { recordWarnings: (w: readonly unknown[]) => void };

function emitter() {
  return new TypedEmitter() as never;
}

beforeEach(() => {
  captured.onDrop = undefined;
  captured.onReadError = undefined;
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
});
