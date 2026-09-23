/** Replay and ordinary submission share the first Enter boundary (PRD §5.3/§5.8). */
import { afterEach, expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { composerClearKeys } from "../../src/core/input/constants.ts";
import { queuedInputSubmitter } from "../../src/core/input/index.ts";
import {
  cancellableSubmission,
  submissionControlOptions,
} from "../../src/core/input/submission-cancel.ts";

afterEach(() => vi.useRealTimers());

test.each([
  false,
  true,
])("C-ATTN-02 turnReplay=%s publishes once after its first awaited Enter", async (turnReplay) => {
  vi.useFakeTimers();
  const firstEnter = Promise.withResolvers<void>();
  const writes: string[] = [];
  const intent = vi.fn();
  const physical = vi.fn();
  const queue = new ControlQueue(
    queuedInputSubmitter(
      {
        sendInput(data) {
          writes.push(String(data));
          if (writes.length === 2) return firstEnter.promise;
          return undefined;
        },
      },
      { snapshot: () => "staged", staged: () => true },
    ),
    () => new Error("closed"),
    intent,
    () => false,
    physical,
  );
  const abort = new AbortController();
  queue.markReady();
  const submitted = queue.send(
    "prompt",
    "message",
    undefined,
    turnReplay ? submissionControlOptions(cancellableSubmission(undefined, abort.signal)) : {},
  );
  const settled = submitted.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(150);
  expect(writes).toEqual(["\u001b[200~prompt\u001b[201~", "\r"]);
  expect(intent).toHaveBeenCalledTimes(turnReplay ? 0 : 1);
  expect(physical).not.toHaveBeenCalled();
  firstEnter.resolve();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(writes).toHaveLength(3);
  expect(intent).toHaveBeenCalledExactlyOnceWith(
    turnReplay ? { kind: "caller", turnReplay: true } : { kind: "caller" },
  );
  expect(physical).toHaveBeenCalledTimes(turnReplay ? 0 : 1);
  abort.abort();
  queue.close();
  await settled;
  await vi.runAllTimersAsync();
  expect(writes).toEqual(
    turnReplay
      ? ["\u001b[200~prompt\u001b[201~", "\r", "\r", composerClearKeys]
      : ["\u001b[200~prompt\u001b[201~", "\r", "\r"],
  );
});
