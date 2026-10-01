/** Awaited replay cannot confuse physical writes, geometry or missing text with acceptance (C-API-56). */
import { afterEach, expect, test, vi } from "vitest";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import { replayFixture } from "./replay-current-fixture.ts";

afterEach(() => vi.useRealTimers());

test("C-API-56 replay observes fresh output after the final Enter and holds successor order", async () => {
  vi.useFakeTimers();
  const h = replayFixture();
  let accepted = false;
  const replay = h.replay().then(() => {
    accepted = true;
  });
  void replay.catch(() => undefined);
  try {
    await vi.advanceTimersByTimeAsync(150);
    expect(h.evidence).toEqual(["physical", "turn"]);
    const next = h.queue.send("next", "prompt");
    void next.catch(() => undefined);
    h.state.empty = {}; // geometry can replace a snapshot without native output
    await vi.advanceTimersByTimeAsync(1_000);
    expect(accepted).toBe(false);
    for (let i = 0; i < 2; i += 1) {
      h.paint();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(h.writes.filter((value) => value === "\r")).toHaveLength(3);
    h.state.staged = false;
    h.state.empty = {};
    await vi.advanceTimersByTimeAsync(1_000);
    expect(accepted).toBe(false); // final write and resized empty token are insufficient
    expect(h.writes.some((value) => value.includes("next"))).toBe(false);
    const render = Promise.withResolvers<void>();
    h.state.settled = () => render.promise;
    h.paint(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(accepted).toBe(false);
    render.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    await replay;
    await vi.advanceTimersByTimeAsync(150);
    await next;
    expect(h.writes.at(-2)).toContain("next");
  } finally {
    h.close();
  }
});

test.each([
  "revoked",
  "blocked",
  "renderFailed",
] as const)("C-API-56 %s retains replay until a safe fresh empty observation", async (hold) => {
  vi.useFakeTimers();
  const h = replayFixture();
  let accepted = false;
  const replay = h.replay().then(() => {
    accepted = true;
  });
  void replay.catch(() => undefined);
  try {
    await vi.advanceTimersByTimeAsync(150);
    h.state[hold] = true;
    h.paint();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(accepted).toBe(false);
    expect(h.writes.filter((value) => value === "\r")).toHaveLength(1);
    h.state.blocked = false;
    h.state.renderFailed = false;
    h.paint(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await replay;
  } finally {
    h.close();
  }
});

test("C-API-56 a fresh staged frame after the last retry rejects and preserves cleanup", async () => {
  vi.useFakeTimers();
  const h = replayFixture();
  const replay = h.replay();
  const failure = expect(replay).rejects.toMatchObject({ code: "wait_timeout" });
  try {
    await vi.advanceTimersByTimeAsync(150);
    for (let i = 0; i < 3; i += 1) {
      h.paint();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(1_000); // failed cleanup observation keeps ownership
    await failure;
    expect(h.writes.filter((value) => value === "\r")).toHaveLength(3);
    const next = h.queue.send("next", "prompt");
    const blocked = expect(next).rejects.toMatchObject({ code: "wait_timeout" });
    await vi.advanceTimersByTimeAsync(1_000);
    await blocked;
    expect(h.writes.some((value) => value.includes("next"))).toBe(false);
  } finally {
    h.close();
  }
});

test("C-API-56 guards without render-progress authority cannot release awaited replay", async () => {
  vi.useFakeTimers();
  const cancel = new AbortController();
  const writes: string[] = [];
  const replay = writeQueuedInput(
    { sendInput: (v) => void writes.push(String(v)) },
    "",
    "awaited_input",
    { snapshot: () => "", staged: () => false, emptyFrame: () => ({}) },
    cancel.signal,
  );
  const failure = expect(replay).rejects.toThrow("cancelled");
  await vi.advanceTimersByTimeAsync(3_150);
  expect(writes).toEqual(["\u001b[200~\u001b[201~", "\r"]);
  cancel.abort(new Error("cancelled"));
  await vi.runAllTimersAsync();
  await failure;
});
