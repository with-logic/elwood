/** Turn replay cancellation clears owned drafts before successor input (C-API-56). */
import { afterEach, expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { ComposerCleanup } from "../../src/core/input/composer-cleanup.ts";
import { composerClearKeys } from "../../src/core/input/constants.ts";
import { queuedInputSubmitter } from "../../src/core/input/index.ts";
import {
  cancellableSubmission,
  submissionControlOptions,
} from "../../src/core/input/submission-cancel.ts";

afterEach(() => vi.useRealTimers());

test.each([
  { nudge: 1, dialog: false },
  { nudge: 2, dialog: false },
  { nudge: 1, dialog: true },
])("C-API-56 cancelled replay nudge $nudge retains its draft through acknowledgement (dialog=$dialog)", async ({
  nudge,
  dialog,
}) => {
  vi.useFakeTimers();
  const physical = Promise.withResolvers<void>();
  const closing = new AbortController();
  const abort = new AbortController();
  const writes: string[] = [];
  let draft = "";
  let emptyFrame: object | undefined;
  let blocked = false;
  let enters = 0;
  const terminal = {
    sendInput(value: string) {
      writes.push(value);
      if (value.startsWith("\u001b[200~")) draft += value.slice(6, -6);
      if (value === "\r" && ++enters === nudge + 1) return physical.promise;
      return undefined;
    },
  };
  const owner = new ComposerCleanup(
    terminal,
    () => blocked,
    closing.signal,
    () => closing.signal,
    () => emptyFrame,
  );
  const submitted = vi.fn();
  const queue = new ControlQueue(
    queuedInputSubmitter(terminal, {
      snapshot: () => draft,
      staged: () => draft === "replay",
      blocked: () => blocked,
    }),
    () => new Error("session_not_running"),
    submitted,
    () => false,
    undefined,
    (work, signal) => owner.run(work, signal),
  );
  try {
    queue.markReady();
    const replay = queue.send(
      "replay",
      "message",
      undefined,
      submissionControlOptions(cancellableSubmission(undefined, abort.signal)),
    );
    const result = replay.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(150 + nudge * 1_000);
    expect(submitted).toHaveBeenCalledOnce();
    expect(enters).toBe(nudge + 1);
    queue.markReady();
    blocked = dialog;
    abort.abort();
    const next = queue.send("next", "message");
    const nextDone = next.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(50);
    expect(writes).toHaveLength(nudge + 2);
    physical.resolve();
    await vi.advanceTimersByTimeAsync(50);
    if (dialog) {
      expect(await result).toEqual(new Error("Turn replay cancelled."));
      expect(writes).not.toContain(composerClearKeys);
      expect(draft).toBe("replay");
      blocked = false;
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(writes.at(-1)).toBe(composerClearKeys);
    expect(draft).toBe("replay");
    await vi.advanceTimersByTimeAsync(100);
    expect(writes.at(-1)).toBe(composerClearKeys);
    // A physical clear is not an acknowledgement: only a fresh native empty frame is.
    draft = "";
    emptyFrame = {};
    await vi.advanceTimersByTimeAsync(200);
    expect(await result).toEqual(new Error("Turn replay cancelled."));
    await nextDone;
    await expect(next).resolves.toBeUndefined();
    expect(draft).toBe("next");
    expect(writes.slice(-3)).toEqual([composerClearKeys, "\u001b[200~next\u001b[201~", "\r"]);
  } finally {
    closing.abort();
    queue.close();
    physical.resolve();
    await vi.runAllTimersAsync();
  }
});

test("C-API-56 successful replay releases its draft ownership after nudges settle", async () => {
  vi.useFakeTimers();
  const closing = new AbortController();
  const writes: string[] = [];
  let staged = true;
  const terminal = {
    sendInput(value: string) {
      writes.push(value);
      if (value === "\r") staged = false;
    },
  };
  const owner = new ComposerCleanup(
    terminal,
    () => false,
    closing.signal,
    () => closing.signal,
    () => ({}),
  );
  const queue = new ControlQueue(
    queuedInputSubmitter(terminal, { snapshot: () => "replay", staged: () => staged }),
    () => new Error("session_not_running"),
    () => undefined,
    () => false,
    undefined,
    (work, signal) => owner.run(work, signal),
  );
  try {
    queue.markReady();
    const replay = queue.send(
      "replay",
      "message",
      undefined,
      submissionControlOptions(cancellableSubmission(undefined, new AbortController().signal)),
    );
    await vi.advanceTimersByTimeAsync(1_150);
    await expect(replay).resolves.toBeUndefined();
    const failure = new Error("later operation failed before staging");
    await expect(queue.runExclusive("list_models", () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    expect(writes).toEqual(["\u001b[200~replay\u001b[201~", "\r"]);
  } finally {
    closing.abort();
    queue.close();
    await vi.runAllTimersAsync();
  }
});
