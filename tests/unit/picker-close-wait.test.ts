/**
 * A model operation releases its queue slot only once its dialog has stayed closed: a blank
 * repaint after which the picker paints again is not a close, and dialog text above the
 * composer is not the dialog (PRD §5.3, C-API-55).
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
import {
  type Barrier,
  escapeKey,
  guardedPickerHarness,
  type Screen,
} from "../helpers/picker-harness.ts";

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

/** An earlier switch's confirmation, still in the transcript above the dialog region. */
const earlier = "• Model changed to gpt-5.5 high\n";
const switched = `• Model changed to gpt-6-astra medium\n${codexClosedPickerViewport}`;
const partialReasoning = codexReasoningViewport.split("\n").slice(0, 7).join("\n");

/**
 * A Codex `setModel` with a message queued behind it. `confirm` paints what follows the
 * reasoning dialog's Enter.
 */
function codexSwitch(confirm: (shown: Screen) => void, barrier: Barrier = {}) {
  const harness = guardedPickerHarness(
    codexClosedPickerViewport,
    (input, shown) => {
      if (input === "/model") shown.text = codexPickerViewport;
      else if (shown.text === codexPickerViewport) shown.text = codexReasoningViewport;
      else confirm(shown);
    },
    codexModelPicker,
    barrier,
  );
  const current = codexModelPicker.parse(codexPickerViewport).options.find((row) => row.isCurrent);
  const switching = harness.picker.run("set_model", codexModelPicker, 5_000, (io) =>
    setPickerModel(io, codexModelPicker, current?.id ?? "", 5_000),
  );
  let settled = false;
  void switching.then(
    () => (settled = true),
    () => (settled = true),
  );
  const message = harness.queue.send("hello", "message");
  return { ...harness, switching, message, settled: () => settled };
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

test.each([
  [
    "a blank frame the dialog repaints over",
    (shown: Screen) => blankThenRepaint(shown, earlier + codexReasoningViewport, switched, earlier),
  ],
  [
    "a blank frame the dialog partly repaints over",
    // The header and two rows: not the complete dialog yet, but the bottom-most region.
    (shown: Screen) => blankThenRepaint(shown, earlier + partialReasoning, switched, earlier),
  ],
])("C-API-55 a model switch's queued message waits out %s", async (_name, confirm) => {
  const { switching, message, delivered, queue, settled } = codexSwitch(confirm);
  await vi.advanceTimersByTimeAsync(399);
  expect(settled()).toBe(false);
  expect(delivered("hello")).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.all([switching, message]);
  expect(delivered("hello")).toBe(1);
  queue.close();
});

test("C-API-55 a listing stays held while only the picker's header is painted", async () => {
  const headerOnly = claudePickerViewport.split("\n").slice(0, 4).join("\n");
  const { queue, picker, delivered } = guardedPickerHarness(
    claudeClosedPickerViewport,
    (input, shown) => {
      if (input === "/model") shown.text = claudePickerViewport;
      if (input === escapeKey) {
        shown.text = headerOnly;
        setTimeout(() => (shown.text = claudeClosedPickerViewport), 400);
      }
    },
  );
  const listing = picker.run("list_models", claudeModelPicker, 5_000, (io) =>
    listPickerModels(io, claudeModelPicker, 5_000),
  );
  let settled = false;
  void listing.then(() => (settled = true));
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(399);
  expect(settled).toBe(false);
  expect(delivered("hello")).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.all([listing, message]);
  expect(delivered("hello")).toBe(1);
  queue.close();
});

test("C-API-55 picker text above the composer does not hold a finished switch", async () => {
  const quoted = `• Model changed to gpt-6-astra medium\n  Select Model and Effort\n${codexClosedPickerViewport}`;
  const { switching, message, delivered, queue, settled } = codexSwitch((shown) => {
    shown.text = quoted;
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(settled()).toBe(true);
  await Promise.all([switching, message]);
  expect(delivered("hello")).toBe(1);
  queue.close();
});

test("C-API-55 a switch whose terminal stops rendering is not reported closed", async () => {
  const barrier: { renderFailed?: boolean } = {};
  const { switching, message, delivered, queue } = codexSwitch((shown) => {
    shown.text = earlier;
    barrier.renderFailed = true;
  }, barrier);
  const failed = expect(switching).rejects.toMatchObject({
    code: "model_automation_failed",
    message: "Could not confirm the codex model picker closed: the terminal stopped rendering.",
  });
  await vi.advanceTimersByTimeAsync(2_000);
  await failed;
  // Its screen proves nothing, so the queued message is never written.
  expect(delivered("hello")).toBe(0);
  queue.close();
  await expect(message).rejects.toThrow("closed");
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
