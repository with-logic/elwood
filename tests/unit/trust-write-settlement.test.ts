/** Safe trust cancellation has no false success or PTY-failure telemetry (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { emitSettledStartupOutcomes } from "../../src/core/startup/write.ts";
import { TrustPromptResponder, type TrustPromptResult } from "../../src/core/trust/responder.ts";

afterEach(() => vi.useRealTimers());

function observe(result: TrustPromptResult<"claude">) {
  if (result?.kind !== "attempted") throw new Error("expected attempted answer");
  const emit = vi.fn();
  const emitWarnings = vi.fn();
  emitSettledStartupOutcomes(
    { emit },
    "claude",
    "s1",
    [{ outcome: { kind: "attempted", ...result.automation }, settled: result.settled }],
    { emitWarnings },
  );
  return { emit, emitWarnings, settled: result.settled };
}

const numbered = "Do you trust this folder?\n1. Yes\n2. No";
const cursor = "Do you trust this folder?\n❯ No\n  Yes";
const replacement = "Enable elevated access\n1. Yes\n2. No";

test.each([
  numbered,
  cursor,
])("C-TRUST-01 cancellation before input emits nothing: %s", async (frame) => {
  const write = vi.fn();
  const responder = new TrustPromptResponder("claude", true);
  const observed = observe(responder.handle(frame, write, () => replacement));
  await expect(observed.settled).resolves.toBe("cancelled");
  expect(write).not.toHaveBeenCalled();
  expect(observed.emit).not.toHaveBeenCalled();
  expect(observed.emitWarnings).not.toHaveBeenCalled();
  const retry = observe(responder.handle(numbered, write));
  await retry.settled;
  expect(write).toHaveBeenCalledWith("1\r");
  expect(retry.emit).toHaveBeenCalledTimes(1);
});

test("C-TRUST-01 a replacement after cursor movement cancels without a false warning", async () => {
  vi.useFakeTimers();
  let frame = cursor;
  const write = vi.fn(() => {
    frame = replacement;
  });
  const observed = observe(
    new TrustPromptResponder("claude", true).handle(cursor, write, () => frame),
  );
  await vi.runAllTimersAsync();
  await expect(observed.settled).resolves.toBe("cancelled");
  expect(write).toHaveBeenCalledExactlyOnceWith("\u001b[B");
  expect(observed.emit).not.toHaveBeenCalled();
  expect(observed.emitWarnings).not.toHaveBeenCalled();
});

test("C-TRUST-01 bounded navigation expiry cancels quietly and remains retryable", async () => {
  vi.useFakeTimers();
  const responder = new TrustPromptResponder("claude", true);
  const observed = observe(responder.handle(cursor, vi.fn(), () => cursor));
  await vi.runAllTimersAsync();
  await expect(observed.settled).resolves.toBe("cancelled");
  expect(observed.emit).not.toHaveBeenCalled();
  expect(observed.emitWarnings).not.toHaveBeenCalled();
  const write = vi.fn();
  const retry = observe(responder.handle(numbered, write));
  await retry.settled;
  expect(write).toHaveBeenCalledExactlyOnceWith("1\r");
});

test("C-CLAUDE-16 an actual PTY rejection still warns and allows retry", async () => {
  const responder = new TrustPromptResponder("claude", true);
  const failure = new Error("secret raw PTY failure");
  const observed = observe(responder.handle(numbered, () => Promise.reject(failure)));
  await expect(observed.settled).rejects.toBe(failure);
  expect(observed.emit).not.toHaveBeenCalled();
  expect(observed.emitWarnings).toHaveBeenCalledExactlyOnceWith([
    expect.objectContaining({ code: "startup_prompt_write_failed", label: "workspace_trust" }),
  ]);
  expect(JSON.stringify(observed.emitWarnings.mock.calls)).not.toContain(failure.message);
  const write = vi.fn();
  await observe(responder.handle(numbered, write)).settled;
  expect(write).toHaveBeenCalledExactlyOnceWith("1\r");
});
