/** Logical update cancellation is quiet; rejected PTY writes warn (C-CODEX-12/17). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { CodexUpdatePromptTracker } from "../../src/codex/update/tracker.ts";
import { writeCodexUpdateSkip } from "../../src/codex/update-prompt.ts";
import { emitSettledStartupOutcomes } from "../../src/core/startup/write.ts";

afterEach(() => vi.useRealTimers());
const prompt = "Update available! 0.153.3 -> 0.153.4\n1. Update now\n2. Skip";

test.each([
  "missing",
  "expired",
])("C-CODEX-17 logical %s cancellation emits no write warning", async (mode) => {
  vi.useFakeTimers();
  const responder = new CodexStartupPromptResponder();
  const emit = vi.fn();
  const emitWarnings = vi.fn();
  const write = vi.fn();
  const frame = mode === "missing" ? prompt.replace("\n2. Skip", "") : prompt;
  const result = responder.handle(prompt, write, () => frame);
  expect(result.outcomes[0]?.outcome.kind).toBe("attempted");
  emitSettledStartupOutcomes({ emit }, "codex", "s1", result.outcomes, { emitWarnings });
  await vi.runAllTimersAsync();
  await expect(result.outcomes[0]?.settled).resolves.toBe("cancelled");
  expect(emitWarnings).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
  // An unpainted option stays retryable; exhaustion stays latched for this appearance.
  const retried = responder.handle(prompt, write);
  if (mode === "expired") expect(retried.outcomes).toEqual([]);
  else await expect(retried.outcomes[0]?.settled).resolves.toBe("cancelled");
});

test("C-CODEX-17 a vanished update cancels before any write", async () => {
  const write = vi.fn();
  await expect(writeCodexUpdateSkip("2", write, () => "Ready")).resolves.toBe("cancelled");
  expect(write).not.toHaveBeenCalled();
});

test("C-CODEX-12 a replacement title invalidates a previously safe update option", async () => {
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(prompt);
  const write = vi.fn();
  const replacement = "Enable experimental cache?\n1. Enable\n2. Skip";
  await expect(
    writeCodexUpdateSkip("2", write, () => replacement, tracker.currentFramePredicate()),
  ).resolves.toBe("cancelled");
  expect(write).not.toHaveBeenCalled();
});

test("C-CODEX-17 actual update PTY rejection retains its bounded warning", async () => {
  const result = new CodexStartupPromptResponder().handle(prompt, () =>
    Promise.reject(new Error("private PTY details")),
  );
  const emit = vi.fn();
  const emitWarnings = vi.fn();
  emitSettledStartupOutcomes({ emit }, "codex", "s1", result.outcomes, { emitWarnings });
  await Promise.allSettled(result.outcomes.map((outcome) => outcome.settled));
  expect(emit).not.toHaveBeenCalled();
  expect(emitWarnings).toHaveBeenCalledWith([
    expect.objectContaining({ code: "startup_prompt_write_failed", label: "update" }),
  ]);
});
