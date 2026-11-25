/** Confirm the bounded native Quit render wait (C-ATTN-07). */
import { afterEach, expect, test, vi } from "vitest";
import { settleQuitRender } from "../../src/codex/workspace-trust/quit-render.ts";
import { deadlineClock } from "../../src/core/timers.ts";
import { terminalDrainTimeoutMs } from "../../src/runtime/shutdown/terminal.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("C-ATTN-07 Quit drain times out once and ignores later render completion", async () => {
  vi.useFakeTimers();
  const { promise, resolve } = Promise.withResolvers<void>();
  const complete = vi.fn();
  settleQuitRender({ settled: () => promise }, complete);
  await vi.advanceTimersByTimeAsync(terminalDrainTimeoutMs);
  resolve();
  await promise;
  expect(complete.mock.calls).toEqual([[false]]);
});

test("C-ATTN-07 late render cannot win when the drain timer has not fired yet", async () => {
  vi.spyOn(deadlineClock, "now").mockReturnValueOnce(0).mockReturnValue(terminalDrainTimeoutMs);
  const complete = vi.fn();
  const settled = Promise.resolve();
  settleQuitRender({ settled: () => settled }, complete);
  await settled;
  expect(complete.mock.calls).toEqual([[false]]);
});
