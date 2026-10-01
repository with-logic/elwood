/** Private replay cancellation retains physical settlement and never clears raw edits (C-API-56). */
import { afterEach, expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import {
  cancellableSubmission,
  submissionControlOptions,
} from "../../src/core/input/submission-cancel.ts";
import { replayFixture } from "./replay-current-fixture.ts";

afterEach(() => vi.useRealTimers());

test.each([
  "cancel",
  "close",
] as const)("C-API-56 replay %s keeps a pending physical Enter owned", async (reason) => {
  vi.useFakeTimers();
  const h = replayFixture();
  const write = Promise.withResolvers<void>();
  h.state.send = async (value) => {
    if (value === "\r") await write.promise;
  };
  let settled = false;
  const replay = h.replay().finally(() => {
    settled = true;
  });
  const failure = expect(replay).rejects.toThrow(reason === "close" ? "closed" : "cancelled");
  try {
    await vi.advanceTimersByTimeAsync(150);
    expect(h.evidence).toEqual([]);
    if (reason === "close") h.close();
    else h.cancel.abort(new Error("cancelled"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    h.state.blocked = true; // defer cancellation cleanup without typing into the dialog
    write.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    await failure;
    expect(h.evidence).toEqual(["physical", "turn"]);
    expect(h.writes).toEqual(["\u001b[200~replay\u001b[201~", "\r"]);
  } finally {
    write.resolve();
    h.close();
  }
});

test("C-API-56 raw input revokes replay retries and cleanup; pre-cancelled replay writes nothing", async () => {
  vi.useFakeTimers();
  const h = replayFixture();
  const replay = h.replay();
  const failure = expect(replay).rejects.toThrow("caller edit");
  try {
    await vi.advanceTimersByTimeAsync(150);
    h.raw.abort(new Error("caller edit"));
    await vi.advanceTimersByTimeAsync(4_000);
    await failure;
    expect(h.writes).toEqual(["\u001b[200~replay\u001b[201~", "\r"]);
    h.cancel.abort(new Error("cancelled"));
    await expect(h.replay()).rejects.toThrow("cancelled");
    expect(h.writes).toHaveLength(2);
  } finally {
    h.close();
  }
});

test("C-API-56 replay turn notification waits for Enter without a physical observer", async () => {
  const entered = Promise.withResolvers<void>();
  const started = vi.fn();
  const queue = new ControlQueue(
    async (_input, _mode, _signal, submitted) => {
      await entered.promise;
      submitted?.();
    },
    () => new Error("closed"),
    started,
  );
  queue.markReady();
  const cancel = new AbortController();
  try {
    const replay = queue.send(
      "replay",
      "message",
      undefined,
      submissionControlOptions(cancellableSubmission(undefined, cancel.signal)),
    );
    expect(started).not.toHaveBeenCalled();
    entered.resolve();
    await replay;
    expect(started).toHaveBeenCalledExactlyOnceWith({
      kind: "caller",
      awaitInputConsumption: true,
    });
  } finally {
    entered.resolve();
    queue.close();
  }
});

test("C-API-56 non-Error cancellation produces an Error without writing replay", async () => {
  const h = replayFixture();
  try {
    h.cancel.abort("caller stopped");
    await expect(h.replay()).rejects.toEqual(new Error("Turn input cancelled."));
    expect(h.writes).toEqual([]);
  } finally {
    h.close();
  }
});
