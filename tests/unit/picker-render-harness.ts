/**
 * Claude picker operations through the real ControlQueue and PickerTransactions, on a
 * scripted terminal that may report its renders, for the render-wake tests (PRD §5.3,
 * C-API-23).
 */
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { PickerTransactions } from "../../src/runtime/session/picker.ts";
import type { ScriptedTerminal } from "./scripted-terminal.ts";

/**
 * Whether the terminal reports completed renders: always, never (it cannot subscribe), or
 * silently (it subscribes but never reports one).
 */
export type RenderReports = "reported" | "unsupported" | "silent";

/**
 * `show` paints a frame and, when renders are `reported`, announces it to every subscribed
 * wait. `subscribed()` counts the waits still listening.
 */
export function renderedPicker(terminal: ScriptedTerminal, renders: RenderReports = "reported") {
  const listeners = new Set<() => void>();
  const queue = new ControlQueue(
    () => Promise.resolve(),
    () => new Error("closed"),
    () => {},
  );
  const picker = new PickerTransactions({
    terminal,
    controlQueue: queue,
    blocked: () => false,
    picker: () => claudeModelPicker,
    submitDirect: (command) => Promise.resolve(terminal.sendInput(command)),
    ...(renders === "unsupported"
      ? {}
      : {
          subscribeRender: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        }),
  });
  queue.markReady();
  const show = (text: string) => {
    terminal.text = text;
    if (renders === "reported") for (const listener of listeners) listener();
  };
  return { picker, queue, show, subscribed: () => listeners.size };
}
