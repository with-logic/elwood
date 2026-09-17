/** Image reservations are released when facade work fails (PRD §5.8, C-API-44). */
import { expect, test } from "vitest";
import { ImageCaptures } from "../../src/core/images/capture.ts";
import { sessionImageBudget } from "../../src/core/images/queued-budget.ts";
import { capturedSend, capturedTurn } from "../../src/core/simple/captured-input.ts";
import { TurnQueue } from "../../src/core/simple/turn-queue.ts";
import { defaultBoundarySignal } from "../../src/core/simple/turn-types.ts";
import { enqueueSubmission } from "../../src/runtime/session/image-attach.ts";
import { FakeUnderlying } from "./simple-fakes.ts";

const options = { images: [{ data: new Uint8Array([1, 2]), format: "png" as const }] };

test.each([
  false,
  true,
])("C-API-44 a launch failure releases captured bytes, sync=%s", async (sync) => {
  const captures = new ImageCaptures(2);
  const facade = {
    status: "starting" as const,
    start() {
      if (sync) throw new Error("launch failed");
      return Promise.reject(new Error("launch failed"));
    },
  };
  const stream = capturedTurn(
    captures,
    new TurnQueue(),
    facade,
    defaultBoundarySignal,
    "go",
    options,
  );
  await expect(stream.next()).rejects.toThrow("launch failed");
  captures.capture(options).release();
});

test("C-API-44 raw submission failure releases captured bytes", async () => {
  const captures = new ImageCaptures(2);
  const underlying = new FakeUnderlying();
  underlying.sendPrompt = () => Promise.reject(new Error("submission failed"));
  const facade = { status: "ready" as const, start: () => Promise.resolve(underlying) };
  await expect(capturedSend(captures, facade, "sendPrompt", "go", options)).rejects.toThrow(
    "submission failed",
  );
  captures.capture(options).release();
});

test("C-API-44 consumer timeout retains image budget until the agent boundary", async () => {
  const captures = new ImageCaptures(2);
  const underlying = new FakeUnderlying();
  underlying.script = () => {};
  const facade = { status: "ready" as const, start: () => Promise.resolve(underlying) };
  const stream = capturedTurn(captures, new TurnQueue(), facade, defaultBoundarySignal, "go", {
    ...options,
    timeoutMs: 1,
  });
  await expect(stream.next()).rejects.toMatchObject({ code: "wait_timeout" });
  expect(() => captures.capture(options)).toThrow(/queued image/);
  underlying.emitter.emit("status", { elwoodSessionId: "s1", status: "stopped" });
  await Promise.resolve();
  captures.capture(options).release();
});

test("C-API-44 an ergonomic turn's reservation bounds raw sends on its session until the boundary", async () => {
  const captures = new ImageCaptures(2);
  const underlying = new FakeUnderlying();
  captures.shareWith(underlying); // what the facade does as it exposes a launched session
  underlying.script = () => {};
  const facade = { status: "ready" as const, start: () => Promise.resolve(underlying) };
  const rawSend = () =>
    enqueueSubmission(
      options.images,
      () => Promise.resolve(),
      async (attach) => attach?.(new AbortController().signal),
      sessionImageBudget(underlying),
    );
  const turn = capturedTurn(
    captures,
    new TurnQueue(),
    facade,
    defaultBoundarySignal,
    "go",
    options,
  );
  const ended = turn.next();
  await expect(rawSend()).rejects.toMatchObject({ code: "invalid_image" });
  underlying.emitter.emit("status", { elwoodSessionId: "s1", status: "stopped" });
  await ended.catch(() => undefined);
  await rawSend(); // the boundary released the turn's bytes; the raw send's own are released too
  captures.capture(options).release();
});
