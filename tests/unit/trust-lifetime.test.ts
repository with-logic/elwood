/** Pending PTY writes never outlive their trust generation or session (C-TRUST-01). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TrustPromptResponder, type TrustPromptResult } from "../../src/core/trust/responder.ts";
import { claudeComposer } from "../fixtures/trust-composer.ts";

const numbered = "Do you trust this folder?\n1. Yes\n2. No";
const cursor = "Do you trust this folder?\n❯ Yes\n  No";
function settled(result: TrustPromptResult<"claude">) {
  if (result?.kind !== "attempted") throw new Error("expected attempt");
  return result.settled;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test.each([
  numbered,
  cursor,
])("C-TRUST-01 disposal aborts a hung write and suppresses late rejection: %s", async (frame) => {
  const responder = new TrustPromptResponder("claude", true);
  const pending = Promise.withResolvers<void>();
  const write = vi.fn(() => pending.promise);
  const attempt = settled(responder.handle(frame, write, () => frame));
  responder.dispose();
  responder.dispose();
  await expect(attempt).resolves.toBe("cancelled");
  expect(responder.inputBlocking).toBe(false);
  expect(responder.blockedPrompt).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  pending.reject(new Error("late private PTY error"));
  await vi.runAllTimersAsync();
  expect(write).toHaveBeenCalledTimes(1);
  expect(responder.handle(frame, write)).toBeUndefined();
});

test.each([
  numbered,
  cursor,
])("C-TRUST-01 disposal cancels polling without another key: %s", async (frame) => {
  const responder = new TrustPromptResponder("claude", true);
  const write = vi.fn();
  const attempt = settled(responder.handle(frame, write, () => frame));
  await vi.advanceTimersByTimeAsync(1);
  responder.dispose();
  await expect(attempt).resolves.toBe("cancelled");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(write).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  "fulfill",
  "reject",
])("C-TRUST-01 a reappeared generation starts before the old write can %s", async (completion) => {
  const changed = vi.fn();
  const responder = new TrustPromptResponder("claude", true, changed);
  const pending = Promise.withResolvers<void>();
  const oldWrite = vi.fn(() => pending.promise);
  const first = settled(responder.handle(numbered, oldWrite, () => numbered));
  responder.handle(claudeComposer, vi.fn());
  let frame = numbered;
  const newWrite = vi.fn();
  const second = settled(responder.handle(frame, newWrite, () => frame));
  await expect(first).resolves.toBe("cancelled");
  expect(newWrite).toHaveBeenCalledExactlyOnceWith("1\r");
  if (completion === "fulfill") pending.resolve();
  else pending.reject(new Error("old failure"));
  await vi.advanceTimersByTimeAsync(1);
  expect(responder.inputBlocking).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  frame = claudeComposer;
  await vi.advanceTimersByTimeAsync(250);
  await expect(second).resolves.toBe("answered");
  expect(responder.inputBlocking).toBe(false);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(oldWrite).toHaveBeenCalledTimes(1);
});

test.each([
  numbered,
  cursor,
])("C-TRUST-01 a hung write expires locally without waiting for PTY completion: %s", async (frame) => {
  const responder = new TrustPromptResponder("claude", true);
  const pending = Promise.withResolvers<void>();
  const write = vi.fn(() => pending.promise);
  const attempt = settled(responder.handle(frame, write, () => frame));
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(attempt).resolves.toBe("cancelled");
  expect(responder.blockedPrompt).toBe("workspace_trust");
  expect(vi.getTimerCount()).toBe(0);
  pending.resolve();
  await vi.runAllTimersAsync();
  expect(write).toHaveBeenCalledTimes(1);
  expect(responder.handle(frame, write, () => frame)).toBeUndefined();
});

test("C-TRUST-01 synchronous write callbacks cannot bypass disposal", async () => {
  const responder = new TrustPromptResponder("claude", true);
  const write = vi.fn(() => responder.dispose());
  await expect(settled(responder.handle(numbered, write, () => numbered))).resolves.toBe(
    "cancelled",
  );
  expect(vi.getTimerCount()).toBe(0);
});

test("C-TRUST-01 disposal during a live read prevents even the first key", async () => {
  const responder = new TrustPromptResponder("claude", true);
  const write = vi.fn();
  const result = responder.handle(numbered, write, () => {
    responder.dispose();
    return numbered;
  });
  await expect(settled(result)).resolves.toBe("cancelled");
  expect(write).not.toHaveBeenCalled();
});

test("C-TRUST-01 a synchronous failure from the current write retains its diagnostic", async () => {
  const responder = new TrustPromptResponder("claude", true);
  const failure = new Error("live PTY failure");
  const write = vi.fn(() => {
    throw failure;
  });
  await expect(settled(responder.handle(numbered, write, () => numbered))).rejects.toBe(failure);
  expect(responder.inputBlocking).toBe(true);
  responder.dispose();
});

test("C-TRUST-01 a synchronous writer that disposes before throwing is quiet", async () => {
  const responder = new TrustPromptResponder("claude", true);
  await expect(
    settled(
      responder.handle(
        numbered,
        () => {
          responder.dispose();
          throw new Error("closed PTY");
        },
        () => numbered,
      ),
    ),
  ).resolves.toBe("cancelled");
});

test("C-TRUST-01 atomic no-reader callers still cancel immediately on disposal", async () => {
  const responder = new TrustPromptResponder("claude", true);
  const pending = Promise.withResolvers<void>();
  const attempt = settled(responder.handle(numbered, () => pending.promise));
  responder.dispose();
  await expect(attempt).resolves.toBe("cancelled");
  pending.resolve();
});

test("C-TRUST-01 disposal in the write-fulfillment microtask cannot install another wait", async () => {
  const responder = new TrustPromptResponder("claude", true);
  const pending = Promise.withResolvers<void>();
  const attempt = settled(
    responder.handle(
      numbered,
      () => pending.promise,
      () => numbered,
    ),
  );
  const closing = pending.promise.then(() => Promise.resolve().then(() => responder.dispose()));
  pending.resolve();
  await closing;
  await expect(attempt).resolves.toBe("cancelled");
  expect(vi.getTimerCount()).toBe(0);
});

test("C-TRUST-01 wall-clock expiry prevents another key even before the timer fires", async () => {
  const responder = new TrustPromptResponder("claude", true);
  const write = vi.fn(() => {
    vi.setSystemTime(Date.now() + 5_000);
  });
  const attempt = settled(responder.handle(numbered, write, () => numbered));
  await vi.advanceTimersByTimeAsync(250);
  await expect(attempt).resolves.toBe("cancelled");
  expect(write).toHaveBeenCalledTimes(1);
  expect(responder.inputBlocking).toBe(true);
  responder.dispose();
});
