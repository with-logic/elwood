/** Loop reservations follow real ergonomic boundaries (PRD §5.8/§5.9, C-API-50). */
import { afterEach, expect, test, vi } from "vitest";
import { ImageCaptures } from "../../src/core/images/capture.ts";
import { capturedTurn } from "../../src/core/simple/captured-input.ts";
import { registerTurnLoopHold } from "../../src/core/simple/loop-hold.ts";
import { TurnQueue } from "../../src/core/simple/turn-queue.ts";
import { defaultBoundarySignal } from "../../src/core/simple/turn-types.ts";
import { TestSimple } from "./simple-fakes.ts";
import { collect } from "./simple-turn-fakes.ts";

afterEach(() => vi.useRealTimers());

function heldSession() {
  const facade = new TestSimple();
  const session = facade.underlying;
  const release = vi.fn();
  const acquire = vi.fn(() => release);
  registerTurnLoopHold(session, acquire);
  session.script = (emitter) => {
    emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
  };
  return { facade, session, release, acquire };
}

test("C-API-50 consumer timeout holds loops until ready and transcript drain", async () => {
  vi.useFakeTimers();
  const { facade, session, release, acquire } = heldSession();
  session.script = (emitter) => {
    expect(acquire).toHaveBeenCalledOnce();
    emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
  };
  const result = facade.send("go", { timeoutMs: 10 }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toMatchObject({ code: "wait_timeout" });
  expect(release).not.toHaveBeenCalled();
  session.emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
  await vi.advanceTimersByTimeAsync(749);
  expect(release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(release).toHaveBeenCalledOnce();
});

test("C-API-50 terminal status releases an unconsumed stream's loop reservation", async () => {
  vi.useFakeTimers();
  const { facade, session, release } = heldSession();
  const stream = facade.stream("go");
  await vi.advanceTimersByTimeAsync(0);
  expect(session.sends).toBe(1);
  session.emitter.emit("status", { elwoodSessionId: "s1", status: "stopped" });
  await vi.advanceTimersByTimeAsync(0);
  expect(release).toHaveBeenCalledOnce();
  await collect(stream).catch(() => undefined);
});

test("C-API-50 failed initial submission releases the loop reservation", async () => {
  const { facade, session, release } = heldSession();
  session.sendMessage = () => Promise.reject(new Error("submission failed"));
  await expect(facade.send("go")).rejects.toThrow("submission failed");
  expect(release).toHaveBeenCalledOnce();
});

test("C-API-50 an unconsumed successful stream releases its loop reservation", async () => {
  vi.useFakeTimers();
  const facade = new TestSimple();
  const release = vi.fn();
  registerTurnLoopHold(facade.underlying, () => release);
  const stream = facade.stream("go");
  await vi.advanceTimersByTimeAsync(2100);
  expect(facade.underlying.sends).toBe(1);
  expect(release).toHaveBeenCalledOnce();
  expect(await collect(stream)).toEqual([{ type: "text", text: "t1" }]);
});

test("C-API-50 a queued startup rejection is contained until its slot releases", async () => {
  vi.useFakeTimers();
  const { session, release } = heldSession();
  let launches = 0;
  const facade = {
    status: "ready" as const,
    start: () =>
      ++launches === 1 ? Promise.resolve(session) : Promise.reject(new Error("launch failed")),
  };
  const captures = new ImageCaptures();
  const queue = new TurnQueue();
  const first = capturedTurn(captures, queue, facade, defaultBoundarySignal, "first");
  const second = capturedTurn(captures, queue, facade, defaultBoundarySignal, "second");
  await vi.advanceTimersByTimeAsync(0);
  expect(session.sends).toBe(1);
  expect(release).not.toHaveBeenCalled();
  session.emitter.emit("status", { elwoodSessionId: "s1", status: "stopped" });
  await collect(first).catch(() => undefined);
  await expect(collect(second)).rejects.toThrow("launch failed");
  expect(release).toHaveBeenCalledOnce();
});

test("C-API-50 a live reservation acquires synchronously and releases once at its boundary", async () => {
  vi.useFakeTimers();
  const { facade, session, acquire, release } = heldSession();
  await facade.start();
  const result = facade.send("go").catch((error: unknown) => error);
  expect(acquire).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(0);
  expect(acquire).toHaveBeenCalledOnce();
  session.emitter.emit("status", { elwoodSessionId: "s1", status: "stopped" });
  await result;
  expect(release).toHaveBeenCalledOnce();
});

test.each([
  false,
  true,
])("C-API-50 startup failure releases a live hold (async=%s)", async (async) => {
  const { session, acquire, release } = heldSession();
  const facade = {
    status: "ready" as const,
    session,
    start: () => {
      if (async) return Promise.reject(new Error("launch failed"));
      throw new Error("launch failed");
    },
  };
  const turn = capturedTurn(
    new ImageCaptures(),
    new TurnQueue(),
    facade,
    defaultBoundarySignal,
    "go",
  );
  expect(acquire).toHaveBeenCalledOnce();
  await expect(collect(turn)).rejects.toThrow("launch failed");
  expect(release).toHaveBeenCalledOnce();
});
