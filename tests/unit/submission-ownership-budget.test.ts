/** Native input ownership remains bounded without borrowing later hooks (PRD §5.9). */
import { afterEach, expect, test, vi } from "vitest";
import { SubmissionOwnership } from "../../src/core/simple/submission-ownership.ts";
import { activity, FakeTurnSession } from "./simple-turn-fakes.ts";

afterEach(() => vi.useRealTimers());
function setup(canonical = (prompt: string) => prompt) {
  const session = new FakeTurnSession();
  const closing = new AbortController();
  const ownership = new SubmissionOwnership(session, closing.signal, canonical);
  return { session, closing, ownership };
}

test.each([
  ["count", "small", 1, 1024],
  ["UTF-8 bytes", "é".repeat(4 * 1024 * 1024), 1, 1],
  ["expanded canonical bytes", "é".repeat(2 * 1024 * 1024), 2, 1],
] as const)("C-LOOP-08 no-hook physical input reaches its %s bound", (_, prompt, repeat, count) => {
  const { ownership, closing } = setup((text) => text.repeat(repeat));
  try {
    for (let i = 0; i < count; i++) ownership.entering(prompt);
    expect(() => ownership.entering("x")).toThrow(
      expect.objectContaining({ code: "input_queue_full", details: {} }),
    );
  } finally {
    closing.abort();
  }
});

test("C-LOOP-08 a failed attempted Enter holds its identical successor until shutdown", async () => {
  const { ownership, closing } = setup();
  const first = ownership.reserve();
  const failure = new Error("write result uncertain");
  await expect(
    first.bindWrite(() => {
      ownership.entering("same");
      return Promise.reject(failure);
    }),
  ).rejects.toBe(failure);
  first.discard();
  const second = ownership.reserve();
  const admitted = vi.fn();
  void second.ready.then(admitted, () => undefined);
  await Promise.resolve();
  await Promise.resolve();
  expect(admitted).not.toHaveBeenCalled();
  closing.abort();
  await expect(second.ready).rejects.toMatchObject({ code: "session_not_running" });
});

test("C-LOOP-08 a swallowed identical prior prompt owns the next matching hook conservatively", async () => {
  vi.useFakeTimers();
  const { ownership, closing, session } = setup();
  try {
    ownership.entering("same");
    ownership.entering("same");
    const next = ownership.reserve();
    const admitted = vi.fn();
    void next.ready.then(admitted, () => undefined);
    session.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "same" });
    session.emit("hook", { hook_event_name: "Stop", last_assistant_message: "answer" });
    session.emit("activity", activity({ text: "answer" }));
    session.emit("status", { status: "ready" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(admitted).not.toHaveBeenCalled();
  } finally {
    closing.abort();
  }
});

test("C-LOOP-08 tagged completion and activity cannot cross native turn identities", async () => {
  vi.useFakeTimers();
  const { ownership, closing, session } = setup();
  try {
    ownership.entering("same");
    const next = ownership.reserve();
    const admitted = vi.fn();
    void next.ready.then(admitted, () => undefined);
    session.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "other", turn_id: "old" });
    session.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "same", turn_id: "new" });
    session.emit("hook", {
      hook_event_name: "Stop",
      turn_id: "old",
      last_assistant_message: "answer",
    });
    session.emit("activity", activity({ text: "answer", turnId: "old" }));
    session.emit("status", { status: "ready" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(admitted).not.toHaveBeenCalled();
    session.emit("hook", {
      hook_event_name: "Stop",
      turn_id: "new",
      last_assistant_message: "answer",
    });
    session.emit("status", { status: "ready" });
    await vi.advanceTimersByTimeAsync(50);
    expect(admitted).not.toHaveBeenCalled();
    session.emit("activity", activity({ text: "answer", turnId: "new" }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(admitted).toHaveBeenCalledOnce();
    next.discard();
  } finally {
    closing.abort();
  }
});

test("C-LOOP-08 shutdown rejects later reservations and physical submissions", () => {
  const { ownership, closing, session } = setup();
  closing.abort();
  expect(session.listenerCount()).toBe(0);
  expect(() => ownership.reserve()).toThrow(
    expect.objectContaining({ code: "session_not_running" }),
  );
  expect(() => ownership.entering("later")).toThrow(
    expect.objectContaining({ code: "session_not_running" }),
  );
});

test("C-LOOP-08 cancelled successors retain bounded order behind an unresolved oldest owner", async () => {
  vi.useFakeTimers();
  const { ownership, closing, session } = setup();
  try {
    ownership.entering("oldest");
    let finalReady: Promise<void> | undefined;
    for (let i = 1; i < 1024; i++) {
      const cancelled = ownership.reserve();
      finalReady = cancelled.ready;
      cancelled.discard();
    }
    let released = false;
    void finalReady!.then(
      () => {
        released = true;
      },
      () => undefined,
    );
    await Promise.resolve();
    expect(released).toBe(false);
    expect(() => ownership.reserve()).toThrow(
      expect.objectContaining({ code: "input_queue_full" }),
    );
    session.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "oldest" });
    session.emit("hook", { hook_event_name: "Stop", last_assistant_message: "answer" });
    session.emit("status", { status: "ready" });
    session.emit("activity", activity({ text: "answer" }));
    await finalReady;
    expect(released).toBe(true);
    const resumed = ownership.reserve();
    await resumed.ready;
    resumed.discard();
  } finally {
    closing.abort();
  }
});
