/**
 * A scripted terminal driving the real ControlQueue and PickerTransactions, shared by
 * the model-picker transaction tests (C-API-55).
 */
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import type { ModelPickerSpec } from "../../src/core/models/picker.ts";
import type { ModelDialogAuthority } from "../../src/core/models/rows.ts";
import { PickerTransactions } from "../../src/runtime/session/picker.ts";
import { clearFrames } from "../../src/runtime/session/picker-cleanup.ts";

export const escapeKey = String.fromCharCode(27);

/**
 * Observes `blocksInput()` until it releases, asserting it stayed held for the full
 * measured clear streak first — one clear frame must never be enough (C-API-55).
 */
export function releasesAfterClearStreak(picker: { blocksInput(): boolean }): boolean {
  for (let frame = 1; frame < clearFrames; frame += 1) {
    if (!picker.blocksInput()) return false;
  }
  return !picker.blocksInput();
}
/** The rejection the cleanup harness's scripted operation fails with. */
export const failure = new Error("navigation failed");
export type Screen = { text: string };
// A raw oracle, so a recognizer regression cannot make a leak look like a clean dispatch.
const dialogTitle =
  /Select model|Select Model and Effort|Select Reasoning Level|Switch model\?|Change effort level\?/;

/** `react` scripts how the fake CLI repaints after each command or key Elwood writes. */
export function pickerHarness(
  text: string,
  react: (input: string, screen: Screen) => void,
  spec: ModelPickerSpec = claudeModelPicker,
) {
  const screen: Screen = { text };
  const writes: string[] = [];
  const terminal = {
    snapshot: () => ({ text: screen.text }),
    sendInput: (input: string | Uint8Array) => {
      writes.push(String(input));
      react(String(input), screen);
    },
  };
  /** Queued input dispatched while any model dialog title was on screen. */
  const leaked: string[] = [];
  const queue = new ControlQueue(
    (input) => {
      if (dialogTitle.test(screen.text)) leaked.push(String(input));
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => {},
  );
  const picker = new PickerTransactions({
    terminal,
    controlQueue: queue,
    blocked: () => false,
    picker: () => spec,
    submitDirect: (command) => Promise.resolve(terminal.sendInput(command)),
  });
  queue.markReady();
  return { screen, writes, leaked, queue, picker };
}

/** `react` scripts how the fake CLI repaints after each command or key Elwood writes. */
export function cleanupHarness(
  spec: ModelPickerSpec,
  react: (input: string, screen: Screen) => void = () => {},
  /** Observation-barrier state a real terminal carries (`renderFailed`, `settled`). */
  barrier: { readonly renderFailed?: boolean } = {},
) {
  const screen: Screen = { text: "❯ " };
  const writes: string[] = [];
  const terminal = {
    ...barrier,
    snapshot: () => ({ text: screen.text }),
    sendInput: (input: string | Uint8Array) => {
      writes.push(String(input));
      return react(String(input), screen);
    },
  };
  /** The harness stands in for a transaction Elwood opened. */
  const opened: ModelDialogAuthority = { opened: true };
  const leaked: string[] = [];
  const queue = new ControlQueue(
    (input) => {
      if (spec.activeDialog(screen.text, opened) !== undefined) leaked.push(String(input));
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => {},
  );
  const picker = new PickerTransactions({
    terminal,
    controlQueue: queue,
    blocked: () => false,
    picker: () => spec,
    submitDirect: (command) => Promise.resolve(terminal.sendInput(command)),
  });
  queue.markReady();
  /** An operation that fails with `dialog` still on screen. */
  const failWith = (dialog: string) =>
    picker.run("set_model", spec, 5000, () => {
      screen.text = dialog;
      return Promise.reject(failure);
    });
  return { screen, writes, leaked, queue, picker, failWith };
}
