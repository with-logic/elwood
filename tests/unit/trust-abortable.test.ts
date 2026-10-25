/** Trust-attempt waits end with their attempt's signal and hold no timer after it (C-TRUST-01). */
import { expect, test, vi } from "vitest";
import { abortableDelay, untilWoken } from "../../src/core/trust/abortable.ts";

test("C-TRUST-01 waits begun after their attempt ended resolve false without arming anything", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  controller.abort();
  const arm = vi.fn();
  await expect(untilWoken(controller.signal, arm)).resolves.toBe(false);
  await expect(abortableDelay(controller.signal, 1_000)).resolves.toBe(false);
  expect(arm).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

test("C-TRUST-01 a frame wait resolves true on wake and false when its attempt ends first", async () => {
  const woken = new AbortController();
  let wake = () => {};
  const waiting = untilWoken(woken.signal, (next) => {
    wake = next;
  });
  wake();
  await expect(waiting).resolves.toBe(true);
  const ended = new AbortController();
  const abandoned = untilWoken(ended.signal, () => {});
  ended.abort();
  await expect(abandoned).resolves.toBe(false);
});
