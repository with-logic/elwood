/**
 * A model operation releases its queue slot only once its dialog has stayed closed: a blank
 * repaint after which the picker paints again is not a close (PRD §5.3, C-API-55).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { listPickerModels, setPickerModel } from "../../src/core/models/picker.ts";
import {
  claudeClosedPickerViewport,
  claudePickerViewport,
  codexClosedPickerViewport,
  codexPickerViewport,
  codexReasoningViewport,
} from "../helpers/model-dialog-viewports.ts";
import { escapeKey, guardedPickerHarness, type Screen } from "../helpers/picker-harness.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** The CLI blanks its dialog region, paints `dialog` again 150 ms later, and closes at 400 ms. */
function blankThenRepaint(screen: Screen, dialog: string, closed: string, above = ""): void {
  screen.text = above;
  setTimeout(() => {
    screen.text = dialog;
  }, 150);
  setTimeout(() => {
    screen.text = closed;
  }, 400);
}

test("C-API-55 a listing's queued message waits out a blank frame the picker repaints over", async () => {
  const { screen, queue, picker, delivered } = guardedPickerHarness(
    claudeClosedPickerViewport,
    (input, shown) => {
      if (input === "/model") shown.text = claudePickerViewport;
      if (input === escapeKey)
        blankThenRepaint(shown, claudePickerViewport, claudeClosedPickerViewport);
    },
  );
  const listing = picker.run("list_models", claudeModelPicker, 5_000, (io) =>
    listPickerModels(io, claudeModelPicker, 5_000),
  );
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(399);
  // Until here the screen was blank, then the picker again: Enter there applies a model.
  expect(screen.text).toBe(claudePickerViewport);
  expect(delivered("hello")).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.all([listing, message]);
  expect(delivered("hello")).toBe(1);
  queue.close();
});

test("C-API-55 a model switch's queued message waits out a blank frame the dialog repaints over", async () => {
  const earlier = "• Model changed to gpt-5.5 high\n";
  const closed = `• Model changed to gpt-6-astra medium\n${codexClosedPickerViewport}`;
  const { screen, queue, picker, delivered } = guardedPickerHarness(
    codexClosedPickerViewport,
    (input, shown) => {
      if (input === "/model") shown.text = codexPickerViewport;
      else if (shown.text === codexPickerViewport) shown.text = codexReasoningViewport;
      // An earlier switch's confirmation stays in the transcript above the blank region.
      else blankThenRepaint(shown, earlier + codexReasoningViewport, closed, earlier);
    },
    codexModelPicker,
  );
  const current = codexModelPicker.parse(codexPickerViewport).options.find((row) => row.isCurrent);
  const switching = picker.run("set_model", codexModelPicker, 5_000, (io) =>
    setPickerModel(io, codexModelPicker, current?.id ?? "", 5_000),
  );
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(399);
  expect(screen.text).toBe(earlier + codexReasoningViewport);
  expect(delivered("hello")).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.all([switching, message]);
  expect(delivered("hello")).toBe(1);
  queue.close();
});

test("C-API-55 a picker that never stays closed fails the listing at its close deadline", async () => {
  const { queue, picker } = guardedPickerHarness(claudeClosedPickerViewport, (input, shown) => {
    if (input === "/model") shown.text = claudePickerViewport;
  });
  const listing = picker.run("list_models", claudeModelPicker, 5_000, (io) =>
    listPickerModels(io, claudeModelPicker, 300),
  );
  const failed = expect(listing).rejects.toMatchObject({
    code: "model_automation_failed",
    message: "Timed out waiting for claude model picker to close.",
  });
  await vi.advanceTimersByTimeAsync(2_000);
  await failed;
  queue.close();
});
