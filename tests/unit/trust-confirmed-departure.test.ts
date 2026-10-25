/**
 * A confirmed trust answer whose gate leaves the frame is neither cleared nor lost: it
 * settles `answered` once verified clearance follows, answers again within the remaining
 * budget if the same gate returns, is cancelled by an off-allowlist gate, and never
 * reports an answer that did not clear (C-TRUST-01, C-CLAUDE-10, C-CODEX-11).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { codexTrustClearance } from "../../src/codex/screen-table.ts";
import type { ElwoodAgentKind } from "../../src/core/activity/index.ts";
import { TrustPromptResponder, type TrustPromptResult } from "../../src/core/trust/responder.ts";
import { claudeComposer, claudeTrust, codexHooks, codexTrust } from "../fixtures/trust-composer.ts";
import { rewordedGate } from "../helpers/unknown-gate.ts";

const cursorGate = `${claudeTrust}\n❯ Yes\n  No`;
const answer = "\u001b[H\r";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function settled<A extends ElwoodAgentKind>(result: TrustPromptResult<A>) {
  if (result?.kind !== "attempted") throw new Error("expected attempt");
  const outcomes: string[] = [];
  void result.settled.then((outcome) => outcomes.push(outcome));
  return { promise: result.settled, outcomes };
}

test("C-TRUST-01 a gate that returns after its answer is answered again within its resumed budget", async () => {
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true);
  let frame = cursorGate;
  // Claude erases the dialog on the first answer, then remounts it; the second clears it.
  const write = vi.fn(() => {
    frame = write.mock.calls.length === 1 ? "" : claudeComposer;
  });
  const attempt = settled(responder.handle(frame, write, () => frame));
  responder.handle(frame, write, () => frame);
  // Far past the five seconds counted from the first paint: only on-screen time counts.
  await vi.advanceTimersByTimeAsync(20_000);
  expect(attempt.outcomes).toEqual([]);
  frame = cursorGate;
  expect(responder.handle(frame, write, () => frame)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(20);
  expect(write.mock.calls).toEqual([[answer], [answer]]);
  responder.handle(frame, write, () => frame);
  await expect(attempt.promise).resolves.toBe("answered");
  expect(responder.inputBlocking).toBe(false);
});

test("C-TRUST-01 a returning gate that stays unanswered spends only its remaining budget and reports nothing", async () => {
  const changed = vi.fn();
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true, {
    onStateChange: changed,
  });
  let frame = cursorGate;
  const write = vi.fn(() => {
    if (write.mock.calls.length === 1) frame = "";
  });
  const attempt = settled(responder.handle(frame, write, () => frame));
  responder.handle(frame, write, () => frame);
  await vi.advanceTimersByTimeAsync(3_000);
  frame = cursorGate;
  responder.handle(frame, write, () => frame);
  await vi.advanceTimersByTimeAsync(4_900);
  expect(responder.blockedPrompt).toBeUndefined();
  expect(write.mock.calls.length).toBeGreaterThan(2);
  await vi.advanceTimersByTimeAsync(100);
  expect(responder.blockedPrompt).toBe("workspace_trust");
  await expect(attempt.promise).resolves.toBe("cancelled");
  const writes = write.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(write).toHaveBeenCalledTimes(writes);
  expect(changed).toHaveBeenCalledOnce();
});

test("C-CODEX-11 an answered directory gate followed by a blank frame and the hooks gate settles answered", async () => {
  const responder = new TrustPromptResponder("codex", codexTrustClearance, true);
  let frame = `${codexTrust}\n› 1. Yes, continue\n  2. No, quit`;
  const write = vi.fn(() => {
    frame = "";
  });
  const directory = settled(responder.handle(frame, write, () => frame));
  responder.handle(frame, write, () => frame);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(directory.outcomes).toEqual([]);
  frame = `${codexHooks}\n1. Trust all and continue\n2. Review hooks`;
  const hooks = responder.handle(frame, write, () => frame);
  await expect(directory.promise).resolves.toBe("answered");
  expect(hooks?.kind).toBe("attempted");
  responder.dispose();
});

test("C-TRUST-01 an unconfirmed selection whose gate leaves loses its choice and starts over on return", async () => {
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true);
  let frame = `${claudeTrust}\n❯ No\n  Yes`;
  const write = vi.fn(() => {
    frame = "";
  });
  const first = settled(responder.handle(frame, write, () => frame));
  expect(write).toHaveBeenCalledExactlyOnceWith("\u001b[H\u001b[B");
  responder.handle(frame, write, () => frame);
  await expect(first.promise).resolves.toBe("cancelled");
  frame = `${claudeTrust}\n❯ No\n  Yes`;
  expect(responder.handle(frame, write, () => frame)?.kind).toBe("attempted");
  responder.dispose();
});

test.each([
  ["the observed frame", rewordedGate, ""],
  ["the attempt's own read", "", rewordedGate],
] as const)("C-TRUST-01 a confirmed answer that meets an off-allowlist gate in %s is cancelled, never reported", async (_where, observed, read) => {
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true);
  let frame = cursorGate;
  const write = vi.fn(() => {
    frame = "";
  });
  const attempt = settled(responder.handle(frame, write, () => frame));
  responder.handle(frame, write, () => frame);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(attempt.outcomes).toEqual([]);
  // A human must answer this gate; the earlier answer cannot be credited for it.
  frame = read;
  responder.handle(observed, write, () => frame);
  await vi.advanceTimersByTimeAsync(20);
  frame = claudeComposer;
  responder.handle(frame, write, () => frame);
  await expect(attempt.promise).resolves.toBe("cancelled");
  expect(write).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
