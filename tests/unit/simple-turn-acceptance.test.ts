/**
 * Acceptance recovery coverage for ergonomic turns that outlive a swallowed
 * cold-start paste. Implements PRD §5.3/§5.8 and C-API-48.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { TurnAcceptance } from "../../src/core/simple/turn-acceptance.ts";
import { activity, collect, drive, runTurnFake } from "./simple-turn-fakes.ts";

afterEach(() => vi.useRealTimers());

describe("C-API-48 positive turn acceptance", () => {
  test("only a matching user activity acknowledges a content-free turn", async () => {
    vi.useFakeTimers();
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("activity", activity({ kind: "warning", text: "go" }));
      s.emit("activity", activity({ kind: "user_message", text: "different" }));
      s.emit("activity", activity({ kind: "user_message", text: "go" }));
      s.emit("status", { status: "ready" });
    });
    const result = collect(runTurnFake(s, { fallbackQuietMs: 10 }).events);
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toEqual([]);
    expect(s.submissions).toBe(1);
  });

  test("acceptance during the quiet window cancels replay and accepts that ready", async () => {
    vi.useFakeTimers();
    const replay = vi.fn(() => Promise.resolve());
    const acceptReady = vi.fn();
    const acceptance = new TurnAcceptance(10, { replay, acceptReady, fail: vi.fn() });
    expect(acceptance.ready()).toBe(false);
    acceptance.accept();
    acceptance.accept(); // idempotent
    await vi.advanceTimersByTimeAsync(10);
    expect(replay).not.toHaveBeenCalled();
    expect(acceptReady).toHaveBeenCalledOnce();
    expect(acceptance.ready()).toBe(true);
    acceptance.running();
    acceptance.dispose();
  });

  test("a rejected recovery submission is surfaced", async () => {
    vi.useFakeTimers();
    const error = new Error("replay failed");
    const fail = vi.fn();
    const acceptance = new TurnAcceptance(10, {
      replay: () => Promise.reject(error),
      acceptReady: vi.fn(),
      fail,
    });
    acceptance.ready();
    await vi.advanceTimersByTimeAsync(10);
    expect(fail).toHaveBeenCalledWith(error);
  });

  test("two still-unaccepted replays fail the turn instead of succeeding empty", async () => {
    vi.useFakeTimers();
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("status", { status: "ready" });
    });
    const result = collect(runTurnFake(s, { fallbackQuietMs: 10, drainMs: 1 }).events);
    const rejected = expect(result).rejects.toMatchObject({ code: "wait_timeout" });
    await vi.advanceTimersByTimeAsync(31);
    await rejected;
    expect(s.submissions).toBe(3);
  });

  test("a successful replay with no later event still exhausts the bounded attempts", async () => {
    vi.useFakeTimers();
    const s = drive((s) => {
      if (s.submissions !== 1) return;
      s.emit("status", { status: "running" });
      s.emit("status", { status: "ready" });
    });
    const result = collect(runTurnFake(s, { fallbackQuietMs: 10, drainMs: 1 }).events);
    const rejected = expect(result).rejects.toMatchObject({ code: "wait_timeout" });
    await vi.advanceTimersByTimeAsync(31);
    expect(s.submissions).toBe(3);
    await rejected;
  });

  test("a synthetic running transition cannot cancel replay recovery", async () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const replay = vi.fn(() => Promise.resolve());
    const acceptance = new TurnAcceptance(10, { replay, acceptReady: vi.fn(), fail });
    acceptance.ready();
    await vi.advanceTimersByTimeAsync(10);
    expect(replay).toHaveBeenCalledOnce();
    acceptance.running();
    await vi.advanceTimersByTimeAsync(20);
    expect(replay).toHaveBeenCalledTimes(2);
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ code: "wait_timeout" }));
  });
});
