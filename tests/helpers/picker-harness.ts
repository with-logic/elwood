/**
 * A scripted terminal driving the real ControlQueue and PickerTransactions, shared by
 * the model-picker transaction tests (C-API-55).
 */
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { PickerTransactions } from "../../src/runtime/session/picker.ts";

export const escapeKey = String.fromCharCode(27);
export type Screen = { text: string };
// A raw oracle, so a recognizer regression cannot make a leak look like a clean dispatch.
const dialogTitle =
  /Select model|Select Model and Effort|Select Reasoning Level|Switch model\?|Change effort level\?/;

/** `react` scripts how the fake CLI repaints after each command or key Elwood writes. */
export function pickerHarness(text: string, react: (input: string, screen: Screen) => void) {
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
    submitDirect: (command) => Promise.resolve(terminal.sendInput(command)),
  });
  queue.markReady();
  return { screen, writes, leaked, queue, picker };
}
