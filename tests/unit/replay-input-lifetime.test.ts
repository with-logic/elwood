/** Physical replay writes stay owned until cancellation settles (PRD §5.8). */
import { afterEach, expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { composerClearKeys } from "../../src/core/input/constants.ts";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import {
  cancellableSubmission,
  submissionControlOptions,
} from "../../src/core/input/submission-cancel.ts";

afterEach(() => vi.useRealTimers());

function setup(blocked: () => boolean = () => false) {
  const writes: string[] = [];
  const started = vi.fn(() => queue.suspendReadiness());
  const queue = new ControlQueue(
    (input, mode, signal, onSubmitted) =>
      writeQueuedInput(
        {
          sendInput: (value) => {
            writes.push(String(value));
          },
        },
        input,
        mode,
        { snapshot: () => "staged", staged: () => true, blocked },
        signal,
        150,
        onSubmitted,
      ),
    () => new Error("closed"),
    started,
  );
  queue.markReady();
  const abort = new AbortController();
  const send = () =>
    queue.send(
      "replay",
      "message",
      undefined,
      submissionControlOptions(cancellableSubmission(undefined, abort.signal)),
    );
  return { writes, started, queue, abort, send };
}

test("Private replay: turn cancellation after first Enter stops every delayed replay Enter", async () => {
  vi.useFakeTimers();
  const h = setup();
  const replay = h.send().catch(() => undefined);
  await vi.advanceTimersByTimeAsync(150);
  expect(h.writes).toEqual(["\u001b[200~replay\u001b[201~", "\r"]);
  expect(h.started).toHaveBeenCalledOnce();
  h.abort.abort();
  await vi.advanceTimersByTimeAsync(5_000);
  await replay;
  expect(h.writes).toEqual(["\u001b[200~replay\u001b[201~", "\r", composerClearKeys]);
  h.queue.close();
});

test("Private replay: a replay cancelled behind a dialog preserves readiness for the next message", async () => {
  vi.useFakeTimers();
  let blocked = true;
  const h = setup(() => blocked);
  const replay = h.send();
  const cancelled = expect(replay).rejects.toThrow("Turn replay cancelled");
  await vi.advanceTimersByTimeAsync(10);
  h.abort.abort();
  await vi.advanceTimersByTimeAsync(50);
  await cancelled;
  expect(h.started).not.toHaveBeenCalled();
  blocked = false;
  const next = h.queue.send("next", "message");
  await vi.advanceTimersByTimeAsync(150);
  expect(h.writes).toEqual(["\u001b[200~next\u001b[201~", "\r"]);
  await next;
  h.queue.close();
});

test("Private replay: an in-flight replay Enter retains its queue slot until the write settles", async () => {
  vi.useFakeTimers();
  const pendingWrite = Promise.withResolvers<void>();
  const writes: string[] = [];
  const queue = new ControlQueue(
    (input, mode, signal, onSubmitted) =>
      writeQueuedInput(
        {
          sendInput(value) {
            writes.push(String(value));
            if (writes.length === 3) return pendingWrite.promise;
            return undefined;
          },
        },
        input,
        mode,
        { snapshot: () => "staged", staged: () => true },
        signal,
        150,
        onSubmitted,
      ),
    () => new Error("closed"),
    () => undefined,
  );
  queue.markReady();
  const abort = new AbortController();
  let replaySettled = false;
  const replay = queue
    .send(
      "replay",
      "message",
      undefined,
      submissionControlOptions(cancellableSubmission(undefined, abort.signal)),
    )
    .catch(() => {
      replaySettled = true;
    });
  await vi.advanceTimersByTimeAsync(1_150);
  expect(writes).toHaveLength(3);
  queue.markReady();
  abort.abort();
  const next = queue.send("next", "message");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(replaySettled).toBe(false);
  expect(writes).toHaveLength(3);
  pendingWrite.resolve();
  await vi.advanceTimersByTimeAsync(150);
  await Promise.all([replay, next]);
  expect(writes).toEqual([
    "\u001b[200~replay\u001b[201~",
    "\r",
    "\r",
    composerClearKeys,
    "\u001b[200~next\u001b[201~",
    "\r",
  ]);
  queue.close();
});

test("Private replay: closing the session waits for an active replay write to settle", async () => {
  const writing = Promise.withResolvers<void>();
  const queue = new ControlQueue(
    () => writing.promise,
    () => new Error("closed"),
    () => undefined,
  );
  queue.markReady();
  let settled = false;
  const replay = queue
    .send(
      "replay",
      "message",
      undefined,
      submissionControlOptions(cancellableSubmission(undefined, new AbortController().signal)),
    )
    .then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
  queue.close();
  await Promise.resolve();
  expect(settled).toBe(false);
  writing.resolve();
  await replay;
  expect(settled).toBe(true);
});
