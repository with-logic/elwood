/** Loop holds follow the real ergonomic boundary (PRD §5.8/§5.9, C-API-50). */
import { afterEach, expect, test, vi } from "vitest";
import { registerTurnLoopHold } from "../../src/core/simple/loop-hold.ts";
import { collect, FakeTurnSession, runTurnFake } from "./simple-turn-fakes.ts";

afterEach(() => vi.useRealTimers());

function heldSession() {
  const session = new FakeTurnSession();
  const release = vi.fn();
  const acquire = vi.fn(() => release);
  registerTurnLoopHold(session, acquire);
  session.script = () => {
    session.emit("status", { status: "running" });
  };
  return { session, release, acquire };
}

test("C-API-50 consumer timeout holds loops until ready and transcript drain", async () => {
  vi.useFakeTimers();
  const { session, release, acquire } = heldSession();
  session.script = () => {
    expect(acquire).toHaveBeenCalledOnce();
    session.emit("status", { status: "running" });
  };
  const turn = runTurnFake(session, { timeoutMs: 10, drainMs: 20 });
  const result = collect(turn.events).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10);
  await turn.completion;
  expect(await result).toMatchObject({ code: "wait_timeout" });
  expect(release).not.toHaveBeenCalled();
  session.emit("status", { status: "ready" });
  await vi.advanceTimersByTimeAsync(19);
  expect(release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await turn.boundary;
  expect(release).toHaveBeenCalledOnce();
});

test("C-API-50 terminal status releases the loop hold", async () => {
  const { session, release } = heldSession();
  const turn = runTurnFake(session);
  session.emit("status", { status: "stopped" });
  await turn.boundary;
  await turn.completion;
  expect(release).toHaveBeenCalledOnce();
});

test("C-API-50 failed initial submission releases the loop hold", async () => {
  const { session, release } = heldSession();
  session.sendResult = Promise.reject(new Error("submission failed"));
  const turn = runTurnFake(session);
  await expect(collect(turn.events)).rejects.toThrow("submission failed");
  await turn.boundary;
  expect(release).toHaveBeenCalledOnce();
});
