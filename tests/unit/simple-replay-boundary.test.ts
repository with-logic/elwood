/** Replay cancellation retains the turn slot and image budget (PRD §5.8, C-API-48). */
import { afterEach, expect, test, vi } from "vitest";
import { ImageCaptures } from "../../src/core/images/capture.ts";
import { submissionControlOptions } from "../../src/core/input/submission-cancel.ts";
import { capturedTurn } from "../../src/core/simple/captured-input.ts";
import { TurnQueue } from "../../src/core/simple/turn-queue.ts";
import { defaultBoundarySignal } from "../../src/core/simple/turn-types.ts";
import { defaultScript, FakeUnderlying } from "./simple-fakes.ts";
import { collect, deferred } from "./simple-turn-fakes.ts";

afterEach(() => vi.useRealTimers());

test.each([
  ["initial", "timeout"],
  ["initial", "success"],
  ["replay", "timeout"],
  ["replay", "success"],
] as const)("C-API-48 %s input on %s holds the next turn and images through cleanup", async (phase, outcome) => {
  vi.useFakeTimers();
  const session = new FakeUnderlying();
  const captures = new ImageCaptures(1);
  const queue = new TurnQueue();
  const facade = { status: session.status, start: () => Promise.resolve(session) };
  const options = { images: [{ data: new Uint8Array([1]), format: "png" as const }] };
  const cleanup = deferred();
  const order: string[] = [];
  let cancelled = false;
  session.sendMessage = async (prompt, sendOptions) => {
    order.push(prompt);
    if (order.length === 1) {
      submissionControlOptions(sendOptions).onSubmitted?.();
      session.emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
      session.emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
    }
    if (order.length === (phase === "initial" ? 1 : 2)) {
      const cancel = submissionControlOptions(sendOptions).cancel;
      if (!cancel) throw new Error("Owned input must carry private cancellation");
      await new Promise<void>((_resolve, reject) => {
        cancel.signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            void cleanup.promise.then(() => reject(cancel.error()));
          },
          { once: true },
        );
      });
    } else if (order.length > 1) defaultScript(session.emitter, "second");
  };
  const first = collect(
    capturedTurn(captures, queue, facade, defaultBoundarySignal, "first", {
      ...options,
      ...(outcome === "timeout" ? { timeoutMs: 2_010 } : {}),
    }),
  );
  const settled =
    outcome === "timeout"
      ? expect(first).rejects.toMatchObject({ code: "wait_timeout" })
      : expect(first).resolves.toHaveLength(1);
  const second = collect(capturedTurn(captures, queue, facade, defaultBoundarySignal, "second"));
  await vi.advanceTimersByTimeAsync(2_000);
  if (outcome === "success") defaultScript(session.emitter, "first");
  await vi.advanceTimersByTimeAsync(2_000);
  await settled;
  expect(cancelled).toBe(true);
  const started = phase === "initial" ? ["first"] : ["first", "first"];
  expect(order).toEqual(started);
  expect(() => captures.capture(options)).toThrow("Too many queued image bytes");
  cleanup.resolve();
  await vi.waitFor(() => expect(order).toEqual([...started, "second"]), { timeout: 1_000 });
  await vi.advanceTimersByTimeAsync(2_000);
  await second;
  expect(order).toEqual([...started, "second"]);
  const recaptured = captures.capture(options);
  recaptured.release();
});
