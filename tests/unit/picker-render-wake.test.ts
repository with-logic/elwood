/**
 * Picker waits read each frame on the render that paints it, not on the next 100 ms poll
 * (PRD §5.3, C-API-23). The close wait after Escape counts its own spaced readings instead
 * (C-API-55).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { clearReadingGapMs, clearReadings } from "../../src/core/models/clearance.ts";
import { listPickerModels } from "../../src/core/models/picker.ts";
import { claudePicker } from "../helpers/model-pickers.ts";
import { closedComposer, escapeKey } from "../helpers/picker-harness.ts";
import { type RenderReports, renderedPicker } from "./picker-render-harness.ts";
import { scripted } from "./scripted-terminal.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** `waitForScreen`'s fallback poll, and the close wait's clear streak after Escape. */
const pollMs = 100;
const closeWaitMs = clearReadings * clearReadingGapMs;

/** How long the fake CLI takes to repaint after a write. */
const paintMs = 5;

/**
 * Lists models from a CLI that opens the picker (unless `opens` is false), and closes it on
 * Escape, `paintMs` later.
 */
async function listing(renders: RenderReports, opens = true) {
  const terminal = scripted(closedComposer(claudeModelPicker));
  const { picker, queue, show, subscribed } = renderedPicker(terminal, renders);
  const paint = (text: string) => setTimeout(() => show(text), paintMs);
  terminal.onInput = (input) => {
    if (input === "/model" && opens) paint(claudePicker);
    else if (input === escapeKey) paint(closedComposer(claudeModelPicker));
  };
  const started = Date.now();
  let finishedAt = Number.POSITIVE_INFINITY;
  const listed = picker
    .run("list_models", claudeModelPicker, 5_000, async (io) => {
      const models = await listPickerModels(io, claudeModelPicker, 5_000);
      finishedAt = Date.now();
      return models;
    })
    .catch((error: unknown) => error);
  // A picker that never opens fails at the operation's own 5 s deadline.
  await vi.advanceTimersByTimeAsync(opens ? 1_000 : 6_000);
  const models = await listed;
  queue.close();
  // Every wait unsubscribes when it ends.
  return { models, elapsedMs: finishedAt - started, subscribed: subscribed() };
}

test("C-API-23 listModels reads the opening picker on the render that paints it", async () => {
  const reported = await listing("reported");
  expect(reported.models).toEqual(claudeModelPicker.parse(claudePicker).options);
  // The picker is read on the render that opens it, with no poll waited out. The close wait
  // then takes its own spaced readings, which no render can shorten (C-API-55).
  expect(reported.elapsedMs).toBe(paintMs + closeWaitMs);
  expect(reported.subscribed).toBe(0);
  // A terminal that cannot report renders still finds the opening picker on the next poll.
  expect((await listing("unsupported")).elapsedMs).toBe(pollMs + closeWaitMs);
});

test("C-API-23 a picker wait still polls when a subscribed terminal reports no render", async () => {
  const silent = await listing("silent");
  expect(silent.models).toEqual(claudeModelPicker.parse(claudePicker).options);
  expect(silent.elapsedMs).toBe(pollMs + closeWaitMs);
  expect(silent.subscribed).toBe(0);
});

test("C-API-23 a subscribed picker wait that times out still unsubscribes", async () => {
  const failed = await listing("silent", false);
  expect(failed.models).toMatchObject({
    code: "model_automation_failed",
    message: expect.stringMatching(/^Timed out waiting for /),
  });
  expect(failed.subscribed).toBe(0);
});
