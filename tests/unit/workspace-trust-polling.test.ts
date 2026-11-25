/** Enforce the native filesystem work bound behind startup trust polls (C-ATTN-07). */
import { expect, test, vi } from "vitest";
import { WorkspaceTrustPolling } from "../../src/core/dialogs/workspace-trust-polling.ts";
import type { TerminalSnapshot } from "../../src/terminal/headless.ts";

const frame = (): TerminalSnapshot => ({
  cols: 100,
  rows: 25,
  cursorX: 0,
  cursorY: 0,
  lines: [],
  text: "",
});

test("C-ATTN-07 repeated native redraws cannot accumulate stalled trust collectors", async () => {
  vi.useFakeTimers();
  const polling = new WorkspaceTrustPolling<"claude">();
  const first = Promise.withResolvers<boolean>();
  const second = Promise.withResolvers<boolean>();
  const collect = vi.fn(async () => true);
  collect.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const accept = vi.fn(() => undefined);
  try {
    const firstPoll = polling.read(frame(), collect, accept);
    expect(firstPoll).toBeDefined();
    await vi.advanceTimersByTimeAsync(500);
    await expect(firstPoll).resolves.toBeUndefined();

    const secondPoll = polling.read(frame(), collect, accept);
    expect(secondPoll).toBeDefined();
    await vi.advanceTimersByTimeAsync(500);
    await expect(secondPoll).resolves.toBeUndefined();

    expect(polling.read(frame(), collect, accept)).toBeUndefined();
    expect(polling.read(frame(), collect, accept)).toBeUndefined();
    expect(collect).toHaveBeenCalledTimes(2);

    first.resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    await polling.read(frame(), collect, accept);
    expect(collect).toHaveBeenCalledTimes(3);
    expect(accept.mock.calls).toEqual([[undefined], [undefined], [true]]);
  } finally {
    first.resolve(false);
    second.resolve(false);
    polling.end();
    vi.useRealTimers();
  }
});
