/**
 * Holds on a model dialog release only on sustained positive composer clearance: never on
 * frames neither grammar recognizes, and never on readings bunched into one instant
 * (PRD §5.3, C-API-55).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { clearObservationGapMs } from "../../src/runtime/session/picker-cleanup.ts";
import { PickerHold } from "../../src/runtime/session/picker-hold.ts";
import {
  claudeClosedPickerViewport,
  claudePickerViewport,
} from "../helpers/model-dialog-viewports.ts";
import { codexPickerCurrentMarkerOnly } from "../helpers/model-pickers.ts";
import {
  failure,
  guardedPickerHarness,
  releasesAfterClearStreak,
} from "../helpers/picker-harness.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const codexComposer = "› Ask Codex to do anything\n  gpt-5.5 high";

test("C-API-55 readings bunched into one instant count once toward clearance", () => {
  const hold = new PickerHold();
  expect(hold.observe(codexPickerCurrentMarkerOnly, codexModelPicker)).toBe(true);
  for (let read = 0; read < 20; read += 1)
    expect(hold.observe(codexComposer, codexModelPicker)).toBe(true);
  expect(releasesAfterClearStreak(() => hold.observe(codexComposer, codexModelPicker))).toBe(true);
});

test("C-API-55 a frame that is not positively clear restarts the clearance streak", () => {
  const hold = new PickerHold();
  hold.hold();
  for (let read = 0; read < 4; read += 1) {
    expect(hold.observe(codexComposer, codexModelPicker)).toBe(true);
    vi.advanceTimersByTime(clearObservationGapMs);
  }
  expect(hold.observe("", codexModelPicker)).toBe(true);
  expect(releasesAfterClearStreak(() => hold.observe(codexComposer, codexModelPicker))).toBe(true);
});

test("C-API-55 a survivor in an unrecognized repaint holds a queued message until the composer clears", async () => {
  // The CLI ignores Escape, so the failed operation's picker survives cleanup.
  const { screen, queue, picker, delivered } = guardedPickerHarness(claudeClosedPickerViewport);
  const failed = expect(
    picker.run("set_model", claudeModelPicker, 5000, async (io) => {
      await io.submit("/model", new AbortController().signal);
      screen.text = claudePickerViewport;
      io.terminal.snapshot();
      throw failure;
    }),
  ).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(1100);
  await failed;
  const message = queue.send("hello", "message");
  // Claude clears the screen and repaints the picker a piece at a time: neither the blank
  // frame nor the rows without their title match a grammar, and neither is a composer.
  for (const repaint of ["", "  2. Haiku  Fast"]) {
    screen.text = repaint;
    await vi.advanceTimersByTimeAsync(5000);
  }
  expect(delivered("hello")).toBe(0);
  screen.text = claudeClosedPickerViewport;
  await vi.advanceTimersByTimeAsync(1000);
  await message;
  expect(delivered("hello")).toBe(1);
  queue.close();
});
