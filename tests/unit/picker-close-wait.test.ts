/**
 * A model operation releases its queue slot only once its dialog has stayed closed: a blank
 * repaint after which the picker paints again is not a close, and dialog text above the
 * composer is not the dialog (PRD §5.3, C-API-55).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { listPickerModels } from "../../src/core/models/picker.ts";
import {
  claudeClosedPickerViewport,
  claudePickerViewport,
  codexClosedPickerViewport,
  codexReasoningViewport,
} from "../helpers/model-dialog-viewports.ts";
import { escapeKey, guardedPickerHarness, type Screen } from "../helpers/picker-harness.ts";
import {
  aroundTheStreak,
  blankThenRepaint,
  closedAt,
  codexSwitch,
  earlier,
  partialReasoning,
  settles,
  switched,
} from "./picker-close-wait-harness.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A Claude listing with a message queued behind it; `escaped` paints what follows Escape. */
function claudeListing(escaped: (shown: Screen) => void) {
  const harness = guardedPickerHarness(claudeClosedPickerViewport, (input, shown) => {
    if (input === "/model") shown.text = claudePickerViewport;
    if (input === escapeKey) escaped(shown);
  });
  const listing = harness.picker.run("list_models", claudeModelPicker, 5_000, (io) =>
    listPickerModels(io, claudeModelPicker, 5_000),
  );
  const message = harness.queue.send("hello", "message");
  return { ...harness, operation: listing, message, settled: settles(listing) };
}

test.each([
  [
    "a listing's queued message waits out a blank frame the picker repaints over",
    () =>
      claudeListing((shown) =>
        blankThenRepaint(shown, claudePickerViewport, claudeClosedPickerViewport),
      ),
  ],
  [
    "a listing stays held while only the picker's header is painted",
    () =>
      claudeListing((shown) => {
        shown.text = claudePickerViewport.split("\n").slice(0, 4).join("\n");
        setTimeout(() => (shown.text = claudeClosedPickerViewport), closedAt);
      }),
  ],
  [
    "a model switch's queued message waits out a blank frame the dialog repaints over",
    () => {
      const run = codexSwitch((shown) =>
        blankThenRepaint(shown, earlier + codexReasoningViewport, switched, earlier),
      );
      return { ...run, operation: run.switching };
    },
  ],
  [
    "a model switch's queued message waits out a blank frame the dialog partly repaints over",
    () => {
      const run = codexSwitch((shown) =>
        blankThenRepaint(shown, earlier + partialReasoning, switched, earlier),
      );
      return { ...run, operation: run.switching };
    },
  ],
])("C-API-55 %s", async (_name, start) => {
  const { operation, message, delivered, queue, settled } = start();
  await vi.advanceTimersByTimeAsync(closedAt - 1);
  // Enter on the dialog still painted here would apply its highlighted row.
  expect(delivered("hello")).toBe(0);
  expect(await aroundTheStreak(settled)).toEqual([false, true]);
  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.all([operation, message]);
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
