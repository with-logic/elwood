/**
 * A failed model operation closes its own picker by ownership, even when no grammar parses
 * the layout, so a parse failure never leaves the picker open and input held (PRD §5.3,
 * C-API-55).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { claudeClosedPickerViewport } from "../helpers/model-dialog-viewports.ts";
import { escapeKey, failure, guardedPickerHarness } from "../helpers/picker-harness.ts";

// Claude 2.1.332 at 100x10: the picker's hint row falls below the pane.
const footerCut = capturedFrame("claude-2.1.332/model-picker/footer-cut");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Fails an operation of Elwood's with its unparsed picker on screen; `onEscape` repaints. */
function failWithPicker(onEscape: (screen: { text: string }) => void) {
  const harness = guardedPickerHarness(claudeClosedPickerViewport, (input, screen) => {
    if (input === escapeKey) onEscape(screen);
  });
  const run = harness.picker.run("list_models", claudeModelPicker, 5000, async (io) => {
    await io.submit("/model", new AbortController().signal);
    harness.screen.text = footerCut;
    io.terminal.snapshot();
    throw failure;
  });
  return { ...harness, run };
}

test("C-API-55 the footer-cut picker is a candidate that no grammar parses", () => {
  expect(claudeModelPicker.activeDialog(footerCut, { opened: true })).toBeUndefined();
  expect(claudeModelPicker.isCandidate(footerCut)).toBe(true);
});

test("C-API-55 cleanup closes its own unparsed picker, then queued input is delivered", async () => {
  // The CLI takes 200 ms to repaint the composer after Escape.
  const { writes, queue, picker, run, delivered } = failWithPicker((screen) => {
    setTimeout(() => {
      screen.text = claudeClosedPickerViewport;
    }, 200);
  });
  const failed = expect(run).rejects.toBe(failure);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(2000);
  await failed;
  expect(writes.slice(0, 2)).toEqual(["/model", escapeKey]);
  expect(writes.filter((write) => write === escapeKey)).toHaveLength(1);
  expect(delivered("hello")).toBe(1);
  expect(picker.blocksInput()).toBe(false);
  await message;
  queue.close();
});

test("C-API-55 an unparsed picker that ignores its Escape gets no second one and holds input", async () => {
  const { writes, queue, picker, run, delivered } = failWithPicker(() => {});
  const failed = expect(run).rejects.toBe(failure);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(5000);
  await failed;
  expect(writes).toEqual(["/model", escapeKey]);
  expect(delivered("hello")).toBe(0);
  expect(picker.blocksInput()).toBe(true);
  queue.close();
  await message.catch(() => undefined);
});
