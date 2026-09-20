/** Both navigation styles retain exact choices and generation ownership (C-TRUST-01). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { codexTrustClearance } from "../../src/codex/screen-table.ts";
import { TrustPromptResponder, type TrustPromptResult } from "../../src/core/trust/responder.ts";
import {
  claudeComposer,
  claudeTrust,
  codexComposer,
  codexHooks,
  codexTrust,
} from "../fixtures/trust-composer.ts";

const numbered = `${claudeTrust}\n1. Yes\n2. No`;
const cursor = `${claudeTrust}\n❯ Yes\n  No`;
function settled(result: TrustPromptResult<"claude"> | TrustPromptResult<"codex">) {
  if (result?.kind !== "attempted") throw new Error("expected attempt");
  return result.settled;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test.each([
  cursor.replace("❯ Yes", "❯ Yes, proceed"),
  cursor.replace("this folder", "the folder"),
  numbered,
  `${claudeTrust}\n❯ No`,
  `${claudeTrust}\n❯ Yes\n  No\nUnknown footer`,
  "Unknown permission\n❯ Yes",
])("C-TRUST-01 a cursor confirmation cannot succeed on replacement: %s", async (replacement) => {
  let frame = cursor;
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true);
  const write = vi.fn(() => {
    frame = replacement;
  });
  const attempt = settled(responder.handle(frame, write, () => frame));
  await vi.advanceTimersByTimeAsync(250);
  await expect(attempt).resolves.toBe("cancelled");
  expect(write).toHaveBeenCalledExactlyOnceWith("\r");
  expect(responder.inputBlocking).toBe(true);
  responder.dispose();
});

test("C-TRUST-01 arrows alone cannot report trust answered when the composer appears", async () => {
  let frame = `${claudeTrust}\n❯ No\n  Yes`;
  const write = vi.fn(() => {
    frame = claudeComposer;
  });
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true);
  const attempt = settled(responder.handle(frame, write, () => frame));
  await vi.runAllTimersAsync();
  await expect(attempt).resolves.toBe("cancelled");
  expect(write).toHaveBeenCalledExactlyOnceWith("\u001b[B");
  expect(responder.inputBlocking).toBe(false);
});

test("C-TRUST-01 swallowed cursor confirmation retries its exact choice", async () => {
  let frame = cursor;
  const write = vi.fn(() => {
    if (write.mock.calls.length === 2) frame = claudeComposer;
  });
  const attempt = settled(
    new TrustPromptResponder("claude", claudeTrustClearance, true).handle(
      frame,
      write,
      () => frame,
    ),
  );
  await vi.runAllTimersAsync();
  await expect(attempt).resolves.toBe("answered");
  expect(write.mock.calls).toEqual([["\r"], ["\r"]]);
});

test("C-TRUST-01 later native cursor rows do not replace the active choice", async () => {
  let frame = `${claudeTrust}\n❯ Yes`;
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true);
  const write = vi.fn(() => {
    if (write.mock.calls.length === 2) frame = claudeComposer;
  });
  const attempt = settled(responder.handle(frame, write, () => frame));
  frame = `${cursor}\nEnter to confirm · Esc to cancel`;
  expect(responder.handle(frame, write, () => frame)).toBeUndefined();
  await vi.runAllTimersAsync();
  await expect(attempt).resolves.toBe("answered");
  expect(write).toHaveBeenCalledTimes(2);
});

test("C-TRUST-01 changed valid choices acquire a new reservation while an old write is pending", async () => {
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true);
  const pending = Promise.withResolvers<void>();
  let frame = numbered;
  const first = settled(
    responder.handle(
      frame,
      () => pending.promise,
      () => frame,
    ),
  );
  frame = numbered.replace("1. Yes\n2. No", "1. No\n2. Yes");
  const write = vi.fn();
  const second = settled(responder.handle(frame, write, () => frame));
  await expect(first).resolves.toBe("cancelled");
  expect(write).toHaveBeenCalledExactlyOnceWith("2\r");
  pending.reject(new Error("superseded write"));
  frame = claudeComposer;
  await vi.runAllTimersAsync();
  await expect(second).resolves.toBe("answered");
});

test("C-TRUST-01 pre-write positive clearance does not report a write that never happened", async () => {
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true);
  const write = vi.fn();
  await expect(settled(responder.handle(numbered, write, () => claudeComposer))).resolves.toBe(
    "cancelled",
  );
  expect(write).not.toHaveBeenCalled();
  expect(responder.inputBlocking).toBe(false);
});

test("C-TRUST-01 hook completion can hand ownership to an unauthorized native directory gate", async () => {
  const responder = new TrustPromptResponder("codex", codexTrustClearance);
  let frame = `${codexHooks}\n1. Trust all and continue\n2. Review hooks`;
  const write = vi.fn(() => {
    frame = `${codexTrust}\n1. Yes, continue`;
  });
  const attempt = settled(responder.handle(frame, write, () => frame));
  await vi.runAllTimersAsync();
  await expect(attempt).resolves.toBe("answered");
  expect(responder.inputBlocking).toBe(true);
  expect(responder.blockedPrompt).toBe("workspace_trust");
  expect(responder.handle(frame, write, () => frame)).toBeUndefined();
  responder.handle("Unknown replacement\n› Continue", write);
  expect(responder.inputBlocking).toBe(true);
  responder.handle(codexComposer, write);
  expect(responder.inputBlocking).toBe(false);
  expect(write).toHaveBeenCalledExactlyOnceWith("1\r");
});

test("C-TRUST-01 poll-observed clearance ends the generation even if it reappears before settlement", async () => {
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true);
  const read = vi
    .fn()
    .mockReturnValueOnce(numbered)
    .mockReturnValueOnce(claudeComposer)
    .mockReturnValue(numbered);
  const write = vi.fn();
  const first = settled(responder.handle(numbered, write, read));
  await vi.advanceTimersByTimeAsync(250);
  await expect(first).resolves.toBe("cancelled");
  expect(responder.inputBlocking).toBe(true);
  const second = settled(responder.handle(numbered, write, () => numbered));
  expect(write).toHaveBeenCalledTimes(2);
  responder.dispose();
  await expect(second).resolves.toBe("cancelled");
});
