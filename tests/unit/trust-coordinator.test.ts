/** Candidate holds, bounded recovery, and verified clearance (C-TRUST-01). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TrustPromptResponder, type TrustPromptResult } from "../../src/core/trust/responder.ts";
import { claudeComposer, claudeTrust } from "../fixtures/trust-composer.ts";

const trust = `${claudeTrust}\n1. Yes\n2. No`;
const unsupported = "Do you trust this folder?\nNew native explanation\n1. Yes";
function settled(result: TrustPromptResult<"claude">) {
  if (result?.kind !== "attempted") throw new Error("expected attempt");
  return result.settled;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test.each([
  "Do you trust this folder?\n1. Yes\n2. No",
  unsupported,
  `${claudeTrust}\n1. Yes\nUnknown footer`,
])("C-TRUST-01 unsupported native candidates hold input and expire without new output: %s", async (frame) => {
  const changed = vi.fn();
  const responder = new TrustPromptResponder("claude", true, changed);
  const write = vi.fn();
  expect(responder.handle(frame, write)).toBeUndefined();
  expect(responder.inputBlocking).toBe(true);
  expect(responder.blockedPrompt).toBeUndefined();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(responder.blockedPrompt).toBe("workspace_trust");
  expect(changed).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
  responder.handle(frame, write);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(changed).toHaveBeenCalledTimes(1);
  responder.handle(claudeComposer, write);
  expect(responder.inputBlocking).toBe(false);
  expect(responder.blockedPrompt).toBeUndefined();
});

test("C-TRUST-01 partial first paint owns the deadline even when choices arrive late", async () => {
  const responder = new TrustPromptResponder("claude", true);
  const write = vi.fn();
  expect(responder.handle(claudeTrust, write)?.kind).toBe("option_pending");
  await vi.advanceTimersByTimeAsync(4_900);
  const attempt = settled(responder.handle(trust, write, () => trust));
  await vi.advanceTimersByTimeAsync(100);
  await expect(attempt).resolves.toBe("cancelled");
  expect(responder.blockedPrompt).toBe("workspace_trust");
  expect(write).toHaveBeenCalledExactlyOnceWith("1\r");
});

test("C-TRUST-01 newly valid recovery rearms once while blocked status remains latched", async () => {
  const responder = new TrustPromptResponder("claude", true);
  const write = vi.fn();
  const first = settled(responder.handle(trust, write, () => trust));
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(first).resolves.toBe("cancelled");
  expect(write).toHaveBeenCalledTimes(20);
  expect(responder.handle(trust, write, () => trust)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(write).toHaveBeenCalledTimes(20);
  responder.handle(unsupported, write);
  let frame = trust;
  const recovered = settled(responder.handle(trust, write, () => frame));
  expect(responder.blockedPrompt).toBe("workspace_trust");
  expect(responder.handle(trust, write, () => frame)).toBeUndefined();
  frame = claudeComposer;
  await vi.advanceTimersByTimeAsync(250);
  await expect(recovered).resolves.toBe("answered");
  expect(responder.blockedPrompt).toBeUndefined();
  expect(responder.inputBlocking).toBe(false);
  expect(write).toHaveBeenCalledTimes(21);
});

test("C-TRUST-01 unknown replacements remain blocked until positively cleared", async () => {
  const responder = new TrustPromptResponder("claude", true);
  let frame = trust;
  const write = vi.fn(() => {
    frame = "Enable elevated access?\n❯ Yes";
  });
  const attempt = settled(responder.handle(trust, write, () => frame));
  await vi.advanceTimersByTimeAsync(250);
  await expect(attempt).resolves.toBe("cancelled");
  expect(responder.inputBlocking).toBe(true);
  await vi.advanceTimersByTimeAsync(4_750);
  expect(responder.blockedPrompt).toBe("workspace_trust");
  responder.handle("Ready\n❯", write);
  expect(responder.inputBlocking).toBe(true);
  responder.handle(claudeComposer, write);
  expect(responder.inputBlocking).toBe(false);
  expect(write).toHaveBeenCalledExactlyOnceWith("1\r");
});

test("C-TRUST-01 new generations can answer the same class again after confirmed clearance", async () => {
  const responder = new TrustPromptResponder("claude", true);
  let frame = trust;
  const write = vi.fn(() => {
    frame = claudeComposer;
  });
  for (let count = 1; count <= 2; count++) {
    frame = trust;
    const attempt = settled(responder.handle(frame, write, () => frame));
    await vi.advanceTimersByTimeAsync(250);
    await expect(attempt).resolves.toBe("answered");
    expect(write).toHaveBeenCalledTimes(count);
    expect(responder.inputBlocking).toBe(false);
  }
});

test("C-TRUST-01 timer observers cannot prevent recovery by throwing", async () => {
  const responder = new TrustPromptResponder("claude", true, () => {
    throw new Error("observer");
  });
  responder.handle(unsupported, vi.fn());
  await vi.runAllTimersAsync();
  expect(responder.blockedPrompt).toBe("workspace_trust");
  responder.dispose();
  expect(responder.inputBlocking).toBe(false);
});

test("C-TRUST-01 non-owned native gates never acquire automation blocking", () => {
  const responder = new TrustPromptResponder("claude");
  expect(responder.handle(trust, vi.fn())).toBeUndefined();
  expect(responder.inputBlocking).toBe(false);
  expect(responder.handle(unsupported, vi.fn())).toBeUndefined();
  expect(responder.inputBlocking).toBe(false);
});

test("C-TRUST-01 a native successor retains expired blocking until the successor clears", async () => {
  const responder = new TrustPromptResponder("claude", true);
  responder.handle(unsupported, vi.fn());
  await vi.runAllTimersAsync();
  const plugin = "Do you trust the plugin?\n1. Yes, trust it\n2. No";
  let frame = plugin;
  const attempt = settled(
    responder.handle(
      plugin,
      () => {
        frame = claudeComposer;
      },
      () => frame,
    ),
  );
  expect(responder.blockedPrompt).toBe("plugin_trust");
  await vi.runAllTimersAsync();
  await expect(attempt).resolves.toBe("answered");
  expect(responder.blockedPrompt).toBeUndefined();
});

test("C-TRUST-01 a header without its native body receives no key until the body paints", async () => {
  const responder = new TrustPromptResponder("claude", true);
  const write = vi.fn();
  let frame = "Do you trust this folder?\n1. Yes\n2. No";
  expect(responder.handle(frame, write, () => frame)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(responder.inputBlocking).toBe(true);
  expect(write).not.toHaveBeenCalled();
  frame = trust;
  const attempt = settled(responder.handle(frame, write, () => frame));
  expect(write).toHaveBeenCalledExactlyOnceWith("1\r");
  frame = claudeComposer;
  await vi.advanceTimersByTimeAsync(250);
  await expect(attempt).resolves.toBe("answered");
  expect(responder.inputBlocking).toBe(false);
});
