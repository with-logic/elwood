/** Fake-timer scripts for a model operation's close wait (PRD §5.3, C-API-55, C-API-56). */

import { vi } from "vitest";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { clearReadingGapMs, clearReadings } from "../../src/core/models/clearance.ts";
import { setPickerModel } from "../../src/core/models/picker.ts";
import {
  codexClosedPickerViewport,
  codexPickerViewport,
  codexReasoningViewport,
} from "../helpers/model-dialog-viewports.ts";
import { type Barrier, guardedPickerHarness, type Screen } from "../helpers/picker-harness.ts";

/** An earlier switch's confirmation, still in the transcript above the dialog region. */
export const earlier = "• Model changed to gpt-5.5 high\n";
export const switched = `• Model changed to gpt-6-astra medium\n${codexClosedPickerViewport}`;
/** The reasoning dialog's header and two rows: not complete yet, but the bottom-most region. */
export const partialReasoning = codexReasoningViewport.split("\n").slice(0, 7).join("\n");

/** Every script below takes its dialog away at this time. */
export const closedAt = 400;

/** The CLI blanks its dialog region, paints `dialog` again 150 ms later, and closes. */
export function blankThenRepaint(screen: Screen, dialog: string, closed: string, above = ""): void {
  screen.text = above;
  setTimeout(() => {
    screen.text = dialog;
  }, 150);
  setTimeout(() => {
    screen.text = closed;
  }, closedAt);
}

/** Whether `operation` has settled yet, either way, read without leaving a rejection unobserved. */
export function settles(operation: Promise<unknown>): () => boolean {
  let settled = false;
  const done = () => {
    settled = true;
  };
  void operation.then(done, done);
  return () => settled;
}

/**
 * Whether the operation had settled just before, then just after, its streak could end.
 * Readings start within one gap of the close wait starting, so the first clear one lands
 * before `closedAt + gap`, and the operation settles on the `clearReadings`-th: never before
 * four more gaps, and by five. Starts from `closedAt - 1`.
 */
export async function aroundTheStreak(settled: () => boolean): Promise<[boolean, boolean]> {
  await vi.advanceTimersByTimeAsync((clearReadings - 1) * clearReadingGapMs);
  const before = settled();
  await vi.advanceTimersByTimeAsync(2 * clearReadingGapMs + 1);
  return [before, settled()];
}

/**
 * A Codex `setModel` with a message queued behind it. `confirm` paints what follows the
 * reasoning dialog's Enter.
 */
export function codexSwitch(confirm: (shown: Screen) => void, barrier: Barrier = {}) {
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
  const message = harness.queue.send("hello", "message");
  return { ...harness, switching, message, settled: settles(switching) };
}
