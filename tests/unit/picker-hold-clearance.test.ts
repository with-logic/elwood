/**
 * Holds on a model dialog release only on sustained positive composer clearance: never on
 * frames neither grammar recognizes, and never on readings bunched into one instant
 * (PRD §5.3, C-API-55).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { clearReadingGapMs } from "../../src/core/models/clearance.ts";
import { PickerHold } from "../../src/runtime/session/picker-hold.ts";
import {
  claudeClosedPickerViewport,
  claudePickerViewport,
  codexPickerViewport,
} from "../helpers/model-dialog-viewports.ts";
import { codexPickerCurrentMarkerOnly } from "../helpers/model-pickers.ts";
import {
  closedComposer,
  escapeKey,
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

// Literal times, not the production constant, so lowering the gap turns this red.
test("C-API-55 a clear reading counts 40 ms after the last counted one, not 39", () => {
  const hold = new PickerHold();
  hold.hold();
  expect(hold.observe(codexComposer, codexModelPicker)).toBe(true);
  for (let counted = 2; counted <= 5; counted += 1) {
    vi.advanceTimersByTime(39);
    expect(hold.observe(codexComposer, codexModelPicker)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hold.observe(codexComposer, codexModelPicker)).toBe(counted < 5);
  }
});

test("C-API-55 a frame that is not positively clear restarts the clearance streak", () => {
  const hold = new PickerHold();
  hold.hold();
  for (let read = 0; read < 4; read += 1) {
    expect(hold.observe(codexComposer, codexModelPicker)).toBe(true);
    vi.advanceTimersByTime(clearReadingGapMs);
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

/** Escape blanks the screen before the CLI paints the composer, or the picker again. */
const blankingEscape = (input: string, shown: { text: string }) => {
  if (input === escapeKey) shown.text = "";
};

test.each([
  ["Claude", "the operation saw", claudeModelPicker, claudePickerViewport, 0],
  ["Claude", "only cleanup saw, after the failure", claudeModelPicker, claudePickerViewport, 300],
  ["Codex", "the operation saw", codexModelPicker, codexPickerViewport, 0],
  ["Codex", "only cleanup saw, after the failure", codexModelPicker, codexPickerViewport, 300],
] as const)("C-API-55 a %s picker %s stays held through a blank repaint until the composer clears", async (_agent, _name, spec, dialog, opensAfterMs) => {
  const { screen, queue, picker, delivered } = guardedPickerHarness(
    closedComposer(spec),
    blankingEscape,
    spec,
  );
  const failed = expect(
    picker.run("set_model", spec, 5000, async (io) => {
      await io.submit("/model", new AbortController().signal);
      if (opensAfterMs === 0) screen.text = dialog;
      io.terminal.snapshot();
      throw failure;
    }),
  ).rejects.toBe(failure);
  if (opensAfterMs > 0)
    setTimeout(() => {
      screen.text = dialog;
    }, opensAfterMs);
  await vi.advanceTimersByTimeAsync(1100);
  await failed;
  // Cleanup's Escape left a blank frame, which is not proof the picker is gone.
  expect(screen.text).toBe("");
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(1000);
  screen.text = dialog;
  await vi.advanceTimersByTimeAsync(1000);
  expect(delivered("hello")).toBe(0);
  screen.text = closedComposer(spec);
  await vi.advanceTimersByTimeAsync(1000);
  await message;
  expect(delivered("hello")).toBe(1);
  queue.close();
});
