/**
 * Cleanup's Escape is decided on everything received and goes only to the stage it was
 * decided for: output that turns the picker into another stage before the write gets no
 * Escape aimed at the picker, and only a stage actually escaped is recorded (PRD §5.3,
 * C-API-55, C-API-56).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import {
  claudeCacheWarningPartialViewport,
  claudeCacheWarningViewport,
  claudeClosedPickerViewport,
  claudePickerViewport,
} from "../helpers/model-dialog-viewports.ts";
import { cleanupHarness, escapeKey, failure, type Screen } from "../helpers/picker-harness.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/**
 * Fails with the picker rendered while `received` already sits in the PTY: the first
 * received-output barrier renders it. Escape on the cache warning returns to the picker,
 * and Escape on the picker closes it.
 */
function failWithReceived(received: string) {
  const screen: { current?: Screen } = {};
  let pending: string | undefined = received;
  const harness = cleanupHarness(
    claudeModelPicker,
    (input, shown) => {
      if (input !== escapeKey) return;
      shown.text =
        shown.text === claudeCacheWarningViewport
          ? claudePickerViewport
          : claudeClosedPickerViewport;
    },
    {
      settled: () => {
        if (pending !== undefined && screen.current !== undefined) {
          screen.current.text = pending;
          pending = undefined;
        }
        return Promise.resolve();
      },
    },
  );
  screen.current = harness.screen;
  return { ...harness, run: harness.failWith(claudePickerViewport) };
}

test("C-API-56 a switch shell received before cleanup's Escape gets no key aimed at the picker", async () => {
  const { writes, run, queue } = failWithReceived(claudeCacheWarningPartialViewport);
  const failed = expect(run).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(2000);
  await failed;
  expect(writes).toEqual(["/model"]);
  queue.close();
});

test("C-API-55 a follow-up received before the picker's Escape gets its own, then the picker gets one", async () => {
  const { writes, run, picker, queue, leaked } = failWithReceived(claudeCacheWarningViewport);
  const failed = expect(run).rejects.toBe(failure);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(2000);
  await failed;
  expect(writes.filter((write) => write === escapeKey)).toHaveLength(2);
  expect(picker.blocksInput()).toBe(false);
  await message;
  expect(leaked).toEqual([]);
  queue.close();
});
