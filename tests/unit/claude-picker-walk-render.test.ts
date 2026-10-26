/**
 * The window walk reads each move on the render that paints it, not on the next 100 ms poll:
 * listing a 13-row picker takes 12 moves, and polling alone adds up to a poll to each
 * (PRD §5.3, C-API-23).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { clearReadingGapMs, clearReadings } from "../../src/core/models/clearance.ts";
import { listPickerModels } from "../../src/core/models/picker.ts";
import { closedComposer } from "../helpers/picker-harness.ts";
import { catalog, escapeKey, fromTop } from "./claude-picker-walk-replay.ts";
import { renderedPicker } from "./picker-render-harness.ts";
import { scripted } from "./scripted-terminal.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** How long the fake CLI takes to repaint after each arrow. */
const paintMs = 5;

/**
 * A listing through the session's picker transactions, on a fake CLI that runs `paint` for
 * each arrow it expects next and announces a render whenever the screen changes.
 */
function listing(paint: (frame: string, show: (text: string) => void) => void) {
  const terminal = scripted(closedComposer(claudeModelPicker));
  const { picker, queue, show } = renderedPicker(terminal);
  let next = 0;
  terminal.onInput = (input) => {
    const step = fromTop.steps[next];
    if (input === "/model") terminal.text = fromTop.opening;
    else if (input === escapeKey) terminal.text = closedComposer(claudeModelPicker);
    else if (input === step?.key) {
      next += 1;
      paint(step.frame, show);
    }
  };
  const started = Date.now();
  let finishedAt = Number.POSITIVE_INFINITY;
  const listed = picker.run("list_models", claudeModelPicker, 5_000, async (io) => {
    const models = await listPickerModels(io, claudeModelPicker, 5_000);
    finishedAt = Date.now();
    return models;
  });
  return { listed, queue, tookMs: () => finishedAt - started };
}

test("C-API-23 listing past the window reads each move as soon as it renders", async () => {
  const { listed, queue, tookMs } = listing((frame, show) =>
    setTimeout(() => show(frame), paintMs),
  );
  await vi.advanceTimersByTimeAsync(2_000);
  expect((await listed).map((model) => model.id)).toEqual(catalog);
  // Twelve repaints of 5 ms each, then the close wait's own streak after Escape. Waiting out
  // the poll instead adds over 1,200 ms.
  const closeStreakMs = (clearReadings - 1) * clearReadingGapMs;
  expect(tookMs()).toBeLessThan(12 * paintMs + closeStreakMs + 50);
  queue.close();
});

test.each([
  ["the rows above the stale count", (frame: string) => frame.replace("+2 models", "+3 models")],
  ["the rows before the count", (frame: string) => frame.replace(/\n.*… \+2 models.*/, "")],
])("C-API-23 a scrolled window is read once its count is repainted, not on %s", async (_name, early) => {
  // The real CLI repaints the scrolled window across renders: the move to row 11 can be read
  // with the new rows painted and the overflow line under them not yet.
  const { listed, queue } = listing((frame, show) => {
    const scrolled = frame.includes("+2 models") && early(frame) !== frame;
    if (scrolled) show(early(frame));
    setTimeout(() => show(frame), scrolled ? 150 : paintMs);
  });
  await vi.advanceTimersByTimeAsync(3_000);
  expect((await listed).map((model) => model.id)).toEqual(catalog);
  queue.close();
});
