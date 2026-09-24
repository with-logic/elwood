/** Ordered native ownership and optional passive boundaries (PRD §5.8/§5.9). */
import { afterEach, expect, test, vi } from "vitest";
import { SubmissionOwnership } from "../../src/core/simple/submission-ownership.ts";
import { activity, FakeTurnSession } from "./simple-turn-fakes.ts";

afterEach(() => vi.useRealTimers());
function setup(canonical = (text: string) => text) {
  vi.useFakeTimers();
  const session = new FakeTurnSession();
  const closing = new AbortController();
  const ownership = new SubmissionOwnership(session, closing.signal, canonical);
  return { session, closing, ownership };
}

test("C-LOOP-08 a reserved Enter waits for its own acceptance, Stop, ready and trailing text", async () => {
  const { session, closing, ownership } = setup((text) => text.trim());
  try {
    const first = ownership.reserve();
    await first.bindWrite(async () => ownership.entering(" same "));
    let completed = false;
    void first.completion.then(
      () => {
        completed = true;
      },
      () => undefined,
    );
    session.emit("status", { status: "running" });
    session.emit("hook", { hook_event_name: "SessionStart" });
    session.emit("activity", activity({ text: "answer" }));
    session.emit("hook", { hook_event_name: "Stop", last_assistant_message: "" });
    session.emit("status", { status: "ready" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(completed).toBe(false);
    session.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "same" });
    // This could be the prior turn’s delayed ready, even after this acceptance.
    session.emit("status", { status: "ready" });
    ownership.confirmNativeIdle();
    await vi.advanceTimersByTimeAsync(3000);
    expect(completed).toBe(false);
    session.emit("hook", { hook_event_name: "Stop", last_assistant_message: "answer" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(completed).toBe(false);
    // Bare pre-Stop ready is not attributable, so a fresh current idle frame is required.
    session.emit("activity", activity({ kind: "notification" }));
    // Claude's accepted hook is untagged; adapter-provided activity metadata does not reject it.
    session.emit("activity", activity({ text: "answer", turnId: "adapter-turn" }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(completed).toBe(false);
    ownership.confirmNativeIdle();
    await first.completion;
    expect(completed).toBe(true);
    expect(session.listenerCount()).toBe(1);
  } finally {
    closing.abort();
  }
});

test("C-LOOP-08 steering does not create ownership for pending or external native work", async () => {
  const { session, closing, ownership } = setup();
  try {
    expect(ownership.hasRunningOwner).toBe(false);
    ownership.observeNativeStatus(true);
    expect(ownership.hasRunningOwner).toBe(true);
    ownership.entering("external steering", true);
    const empty = ownership.reserve();
    await empty.ready;
    ownership.confirmNativeIdle();
    expect(ownership.hasRunningOwner).toBe(false);
    empty.discard();
    ownership.entering("primary");
    ownership.entering("pending steering", true);
    expect(ownership.hasRunningOwner).toBe(false);
    session.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "primary" });
    expect(ownership.hasRunningOwner).toBe(true);
    session.emit("hook", { hook_event_name: "Stop", last_assistant_message: "answer" });
    expect(ownership.hasRunningOwner).toBe(false);
    session.emit("status", { status: "ready" });
    session.emit("activity", activity({ text: "answer" }));
    await ownership.reserve().ready;
  } finally {
    closing.abort();
  }
});

test("C-LOOP-08 failed byte admission rejects completion and admits its queued successor", async () => {
  const { ownership, closing } = setup();
  try {
    const rejected = ownership.reserve();
    const next = ownership.reserve();
    const admitted = vi.fn();
    void next.ready.then(admitted, () => undefined);
    await expect(
      rejected.bindWrite(async () => ownership.entering("x".repeat(8 * 1024 * 1024 + 1))),
    ).rejects.toMatchObject({ code: "input_queue_full" });
    await expect(rejected.completion).rejects.toMatchObject({ code: "input_queue_full" });
    rejected.discard();
    await vi.advanceTimersByTimeAsync(1);
    expect(admitted).toHaveBeenCalledOnce();
    await next.ready;
    next.discard();
  } finally {
    closing.abort();
  }
});

test("C-LOOP-08 completed ownership releases retained canonical bytes for the next input", async () => {
  const { session, closing, ownership } = setup();
  try {
    const prompt = "x".repeat(8 * 1024 * 1024);
    const first = ownership.reserve();
    await first.bindWrite(async () => ownership.entering(prompt));
    session.emit("hook", { hook_event_name: "UserPromptSubmit", prompt });
    session.emit("hook", { hook_event_name: "Stop", last_assistant_message: "answer" });
    session.emit("status", { status: "ready" });
    session.emit("activity", activity({ text: "answer" }));
    await first.completion;
    expect(() => ownership.entering(prompt)).not.toThrow();
  } finally {
    closing.abort();
  }
});

test.each([
  "retired",
  "held",
  "continuation",
] as const)("C-LOOP-08 discarded %s reservations reject late writes", async (state) => {
  const { session, closing, ownership } = setup();
  try {
    if (state !== "retired") ownership.entering("earlier");
    const retired = ownership.reserve();
    const resume = Promise.withResolvers<void>();
    const write = async () => {
      await resume.promise;
      ownership.entering("x".repeat(4 * 1024 * 1024));
    };
    if (state !== "continuation") retired.discard();
    const pending = retired.bindWrite(write);
    retired.discard();
    resume.resolve();
    await expect(pending).rejects.toThrow("Submission reservation is no longer active.");
    expect(session.listenerCount()).toBe(state === "retired" ? 1 : 4);
    expect(() => ownership.entering("still fits")).not.toThrow();
  } finally {
    closing.abort();
  }
});
