/** Awaited input reacts to completed native frames without idle polling (PRD §5.3, C-API-31). */
import { afterEach, expect, test, vi } from "vitest";
import { preparePasteNudges } from "../../src/core/input/paste-nudge.ts";

afterEach(() => vi.useRealTimers());

function observation() {
  vi.useFakeTimers();
  const cancel = new AbortController();
  const listeners = new Set<() => void>();
  let revision = 0;
  let empty: object | undefined;
  const staged = vi.fn(() => false);
  const sendInput = vi.fn(async () => undefined);
  const nudges = preparePasteNudges(
    { sendInput, settled: async () => undefined },
    {
      prepareStaged: () => staged,
      emptyFrame: () => empty,
      captureRenderProgress: () => {
        const before = revision;
        return () => revision > before;
      },
      subscribeRender: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    "hello",
    cancel.signal,
    1_000,
    undefined,
  );
  nudges?.beforeEnter();
  const result = nudges?.awaitEmptyInput();
  const paint = (isEmpty: boolean) => {
    revision += 1;
    empty = isEmpty ? {} : undefined;
    for (const listener of listeners) listener();
  };
  return { cancel, listeners, staged, sendInput, result, paint };
}

test("C-API-31 fresh empty input settles before the recovery cadence", async () => {
  const h = observation();
  let accepted = false;
  const done = h.result?.then(
    () => {
      accepted = true;
    },
    () => undefined,
  );
  try {
    h.paint(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(accepted).toBe(true);
    expect(h.sendInput).not.toHaveBeenCalled();
  } finally {
    h.cancel.abort();
    await done;
  }
});

test("C-API-31 unchanged ambiguous input keeps no polling timer or repeated scan", async () => {
  const h = observation();
  const done = h.result?.catch(() => undefined);
  try {
    h.paint(false);
    await vi.advanceTimersByTimeAsync(0);
    const scans = h.staged.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.staged).toHaveBeenCalledTimes(scans);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.sendInput).not.toHaveBeenCalled();
  } finally {
    h.cancel.abort();
    await done;
  }
  expect(h.listeners.size).toBe(0);
});

test("C-API-31 staged retry pacing is not accelerated by repeated completed frames", async () => {
  const h = observation();
  h.staged.mockReturnValue(true);
  const done = h.result?.catch(() => undefined);
  try {
    h.paint(false);
    await vi.advanceTimersByTimeAsync(400);
    h.paint(false);
    await vi.advanceTimersByTimeAsync(599);
    expect(h.sendInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sendInput).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sendInput).toHaveBeenCalledTimes(1); // no new native output after Enter
    h.paint(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sendInput).toHaveBeenCalledTimes(2);
    h.paint(false);
    await vi.advanceTimersByTimeAsync(999);
    let finished = false;
    void done?.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await h.result).toBe(false);
    expect(h.sendInput).toHaveBeenCalledTimes(2);
  } finally {
    h.cancel.abort();
    await done;
  }
  expect(h.listeners.size).toBe(0);
});
