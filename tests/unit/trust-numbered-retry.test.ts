/** Native numbered trust retries remain bounded and generation-safe (C-TRUST-01). */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { emitSettledStartupOutcomes } from "../../src/core/startup/write.ts";
import { TrustPromptResponder, type TrustPromptResult } from "../../src/core/trust/responder.ts";

const trust = "Do you trust this folder?\n1. Yes\n2. No";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function settled(result: TrustPromptResult<"claude"> | TrustPromptResult<"codex">) {
  if (result?.kind !== "attempted") throw new Error("expected attempt");
  return result.settled;
}

function observe(result: TrustPromptResult<"claude">) {
  if (result?.kind !== "attempted") throw new Error("expected attempt");
  const emit = vi.fn();
  const emitWarnings = vi.fn();
  emitSettledStartupOutcomes(
    { emit },
    "claude",
    "s1",
    [
      {
        outcome: { kind: "attempted", ...result.automation },
        settled: result.settled,
      },
    ],
    { emitWarnings },
  );
  return { emit, emitWarnings, settled: result.settled };
}

test("C-TRUST-01 swallowed first numbered write retries and reports success only after clearance", async () => {
  let frame = trust;
  const write = vi.fn(() => {
    if (write.mock.calls.length === 2) frame = "› Ready";
  });
  const observed = observe(
    new TrustPromptResponder("claude", true).handle(trust, write, () => frame),
  );
  await vi.advanceTimersByTimeAsync(249);
  expect(write).toHaveBeenCalledExactlyOnceWith("1\r");
  expect(observed.emit).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  await expect(observed.settled).resolves.toBe("answered");
  expect(write.mock.calls).toEqual([["1\r"], ["1\r"]]);
  expect(observed.emit).toHaveBeenCalledTimes(1);
  expect(observed.emitWarnings).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(write).toHaveBeenCalledTimes(2);
});

test.each([
  "Do you trust this folder?\n1. Yes, proceed\n2. No",
  "Do you trust this folder?\n1. No\n2. Yes",
  "Do you trust this folder?\n2. No",
  "Do you trust this folder?\n❯ Yes\n  No",
  "Do you trust this folder?\nClaude Code'll be able to read, edit, and execute files here.\n1. Yes\n2. No",
  "Do you trust this folder?\nUnknown explanation\n1. Yes\n2. No",
  "Enable elevated access?\n1. Yes\n2. No",
  "Enable elevated access?\n1. Yes",
  "Enable elevated access?\n❯ Yes\n  No",
])("C-TRUST-01 replacement or missing safe identity cancels quietly: %s", async (replacement) => {
  let frame = trust;
  const write = vi.fn(() => {
    frame = replacement;
  });
  const observed = observe(
    new TrustPromptResponder("claude", true).handle(trust, write, () => frame),
  );
  await vi.runAllTimersAsync();
  await expect(observed.settled).resolves.toBe("cancelled");
  expect(write).toHaveBeenCalledExactlyOnceWith("1\r");
  expect(observed.emit).not.toHaveBeenCalled();
  expect(observed.emitWarnings).not.toHaveBeenCalled();
});

test("C-TRUST-01 a clear-and-reappear generation between polls cancels the old attempt", async () => {
  const responder = new TrustPromptResponder("claude", true);
  let frame = trust;
  const write = vi.fn();
  const first = settled(responder.handle(frame, write, () => frame));
  responder.handle("Ready", write);
  responder.handle(frame, write, () => frame);
  await vi.runAllTimersAsync();
  await expect(first).resolves.toBe("cancelled");
  expect(write).toHaveBeenCalledExactlyOnceWith("1\r");
  const retry = settled(
    responder.handle(
      frame,
      () => {
        frame = "Ready";
      },
      () => frame,
    ),
  );
  await vi.runAllTimersAsync();
  await expect(retry).resolves.toBe("answered");
});

test("C-TRUST-01 numbered expiry is bounded, quiet, and retryable", async () => {
  const responder = new TrustPromptResponder("claude", true);
  const write = vi.fn();
  const observed = observe(responder.handle(trust, write, () => trust));
  await vi.runAllTimersAsync();
  await expect(observed.settled).resolves.toBe("cancelled");
  expect(write).toHaveBeenCalledTimes(20);
  expect(observed.emit).not.toHaveBeenCalled();
  expect(observed.emitWarnings).not.toHaveBeenCalled();
  await expect(settled(responder.handle(trust, write))).resolves.toBe("answered");
  expect(write).toHaveBeenCalledTimes(21);
});

test("C-CODEX-17 a native directory-to-hook successor confirms clearance without an old retry", async () => {
  const directory = readFileSync(
    new URL("../fixtures/codex-0.154.0/directory.txt", import.meta.url),
    "utf8",
  );
  const hooks = readFileSync(
    new URL("../fixtures/codex-0.154.0/hooks.txt", import.meta.url),
    "utf8",
  );
  const responder = new TrustPromptResponder("codex", true);
  let frame = directory;
  const write = vi.fn(() => {
    frame = hooks;
  });
  const first = settled(responder.handle(directory, write, () => frame));
  await settled(responder.handle(hooks, () => undefined));
  await vi.runAllTimersAsync();
  await expect(first).resolves.toBe("answered");
  expect(write).toHaveBeenCalledExactlyOnceWith("1\r");
});

test("C-CLAUDE-16 live numbered PTY rejection warns instead of retrying", async () => {
  const failure = new Error("private PTY failure");
  const write = vi.fn(() => Promise.reject(failure));
  const observed = observe(
    new TrustPromptResponder("claude", true).handle(trust, write, () => trust),
  );
  await expect(observed.settled).rejects.toBe(failure);
  await vi.runAllTimersAsync();
  expect(write).toHaveBeenCalledExactlyOnceWith("1\r");
  expect(observed.emit).not.toHaveBeenCalled();
  expect(observed.emitWarnings).toHaveBeenCalledExactlyOnceWith([
    expect.objectContaining({ code: "startup_prompt_write_failed" }),
  ]);
});

test("C-TRUST-01 later native decline rows preserve the active numbered retry", async () => {
  const responder = new TrustPromptResponder("claude", true);
  let frame = "Do you trust this folder?\n1. Yes";
  const write = vi.fn(() => {
    if (write.mock.calls.length === 2) frame = "Ready";
  });
  const observed = observe(responder.handle(frame, write, () => frame));
  frame = trust;
  expect(responder.handle(frame, write, () => frame)).toBeUndefined();
  await vi.runAllTimersAsync();
  await expect(observed.settled).resolves.toBe("answered");
  expect(write.mock.calls).toEqual([["1\r"], ["1\r"]]);
  expect(observed.emit).toHaveBeenCalledTimes(1);
  expect(observed.emitWarnings).not.toHaveBeenCalled();
});
