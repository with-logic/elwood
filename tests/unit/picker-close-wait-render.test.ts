/**
 * Each close-wait reading is of everything the terminal received: a repaint not yet in the
 * snapshot is rendered before it counts, and a terminal that cannot render fails the wait
 * rather than counting its last frame (PRD §5.3, C-API-55, C-API-56).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { codexReasoningViewport } from "../helpers/model-dialog-viewports.ts";
import {
  aroundTheStreak,
  closedAt,
  codexSwitch,
  earlier,
  switched,
} from "./picker-close-wait-harness.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("C-API-56 a close reading renders a repaint already received before counting", async () => {
  // The repaint has reached the terminal but not the snapshot: only `settled` renders it.
  const pending: { repaint?: (() => void) | undefined } = {};
  const barrier = {
    settled: () => {
      pending.repaint?.();
      pending.repaint = undefined;
      return Promise.resolve();
    },
  };
  const { switching, message, delivered, queue, settled } = codexSwitch((shown) => {
    shown.text = earlier;
    pending.repaint = () => {
      shown.text = earlier + codexReasoningViewport;
    };
    setTimeout(() => (shown.text = switched), closedAt);
  }, barrier);
  await vi.advanceTimersByTimeAsync(closedAt - 1);
  expect(delivered("hello")).toBe(0);
  expect(await aroundTheStreak(settled)).toEqual([false, true]);
  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.all([switching, message]);
  expect(delivered("hello")).toBe(1);
  queue.close();
});

test("C-API-56 a switch whose terminal stops rendering is not reported closed", async () => {
  const barrier: { renderFailed?: boolean } = {};
  const { switching, message, delivered, queue } = codexSwitch((shown) => {
    shown.text = earlier;
    barrier.renderFailed = true;
  }, barrier);
  const failed = expect(switching).rejects.toMatchObject({
    code: "model_automation_failed",
    message:
      "Could not confirm the codex model picker closed: its received output could not be rendered.",
  });
  await vi.advanceTimersByTimeAsync(2_000);
  await failed;
  // Its screen proves nothing, so the queued message is never written.
  expect(delivered("hello")).toBe(0);
  queue.close();
  await expect(message).rejects.toThrow("closed");
});
