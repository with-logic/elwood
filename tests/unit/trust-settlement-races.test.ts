/** Rejected writes lose publication authority with their reservation (C-TRUST-01). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TrustPromptResponder, type TrustPromptResult } from "../../src/core/trust/responder.ts";
import { claudeComposer } from "../fixtures/trust-composer.ts";

const trust = "Do you trust this folder?\n1. Yes\n2. No";
function settled(result: TrustPromptResult<"claude">) {
  if (result?.kind !== "attempted") throw new Error("expected attempt");
  return result.settled;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test.each([
  "clear",
  "replace",
  "dispose",
])("C-TRUST-01 %s between write rejection and coordinator settlement suppresses stale diagnostics", async (change) => {
  const responder = new TrustPromptResponder("claude", true);
  const pending = Promise.withResolvers<void>();
  const first = settled(
    responder.handle(
      trust,
      () => pending.promise,
      () => trust,
    ),
  );
  pending.reject(new Error("old private write failure"));
  // Propagate the rejection through the PTY wait and attempt, leaving the
  // coordinator's queued completion job to race the new observed frame.
  for (let tick = 0; tick < 4; tick++) await Promise.resolve();
  let second: Promise<"answered" | "cancelled"> | undefined;
  if (change === "clear") responder.handle(claudeComposer, vi.fn());
  else if (change === "dispose") responder.dispose();
  else {
    const replacement = trust.replace("1. Yes\n2. No", "1. No\n2. Yes");
    const write = vi.fn();
    second = settled(responder.handle(replacement, write, () => replacement));
    await expect(first).resolves.toBe("cancelled");
    expect(responder.handle(replacement, write, () => replacement)).toBeUndefined();
    expect(write).toHaveBeenCalledExactlyOnceWith("2\r");
  }
  await expect(first).resolves.toBe("cancelled");
  responder.dispose();
  if (second !== undefined) await expect(second).resolves.toBe("cancelled");
  expect(vi.getTimerCount()).toBe(0);
});
