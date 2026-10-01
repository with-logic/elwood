/** Real queued replay and composer ownership with controlled rendered evidence (C-API-56). */
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { ComposerCleanup } from "../../src/core/input/composer-cleanup.ts";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import {
  cancellableSubmission,
  submissionControlOptions,
} from "../../src/core/input/submission-cancel.ts";

export function replayFixture() {
  const listeners = new Set<() => void>();
  const writes: string[] = [];
  const evidence: string[] = [];
  const closing = new AbortController();
  const cancel = new AbortController();
  const raw = new AbortController();
  const state = {
    revision: 0,
    empty: undefined as object | undefined,
    staged: true,
    revoked: false,
    blocked: false,
    renderFailed: false,
    settled: () => Promise.resolve(),
    send: async (_value: string) => {},
  };
  const terminal = {
    settled: () => state.settled(),
    get renderFailed() {
      return state.renderFailed;
    },
    async sendInput(value: string | Uint8Array) {
      writes.push(String(value));
      await state.send(String(value));
    },
  };
  const guard = {
    subscribeRender: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    prepareStaged: () => () => state.staged,
    emptyFrame: () => state.empty,
    captureRecovery: () => ({ revoked: () => state.revoked }),
    captureRenderProgress: () => {
      const before = state.revision;
      return () => state.revision > before;
    },
    blocked: () => state.blocked,
  };
  const cleanup = new ComposerCleanup(
    terminal,
    guard.blocked,
    closing.signal,
    () => raw.signal,
    guard.emptyFrame,
  );
  const queue = new ControlQueue(
    (input, mode, signal, onSubmitted) =>
      writeQueuedInput(terminal, input, mode, guard, signal, 150, onSubmitted),
    () => new Error("closed"),
    () => evidence.push("turn"),
    undefined,
    () => evidence.push("physical"),
    (work, signal) => cleanup.run(work, signal),
  );
  queue.markReady();
  const replay = () =>
    queue.send(
      "replay",
      "message",
      undefined,
      submissionControlOptions(cancellableSubmission(undefined, cancel.signal)),
    );
  const paint = (empty = false) => {
    state.revision += 1;
    state.empty = empty ? {} : undefined;
    for (const listener of listeners) listener();
  };
  return {
    writes,
    evidence,
    closing,
    cancel,
    raw,
    state,
    terminal,
    guard,
    queue,
    replay,
    paint,
    close() {
      closing.abort();
      queue.close();
    },
  };
}
