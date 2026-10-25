/**
 * A model operation's close wait: the queue slot is released only once the operation's
 * dialog has stayed gone, not on the first frame that lacks it (PRD §5.3, C-API-55).
 */

import { delay } from "../delay.ts";
import { elwoodError } from "../errors.ts";
import { clearReadingGapMs, clearReadings } from "./clearance.ts";
import type { ModelPickerIo, ModelPickerSpec } from "./picker.ts";
import type { ModelDialogAuthority } from "./rows.ts";

const opened: ModelDialogAuthority = { opened: true };

/**
 * Whether any stage of the operation's dialog, or its header, still shows. Deliberately
 * weaker than `isOwnCompletePicker`, because it only waits: a picker mid-close may still
 * show either. It never gates a write.
 */
const closing = (spec: ModelPickerSpec, text: string) =>
  spec.activeDialog(text, opened) !== undefined || spec.hasPickerHeader(text);

/**
 * Resolves once neither the dialog nor its header has shown across `clearReadings`
 * readings spaced `clearReadingGapMs` apart; any reading that shows either restarts the
 * count. One frame without the picker is not proof it closed: a blank or half-painted
 * repaint lacks it too, and the picker can paint again after it, where a queued Enter
 * released by this operation would apply the highlighted model. Absence, not positive
 * composer clearance, is what is counted: clearance excludes a running turn, and model
 * operations run during turns (C-API-35).
 */
export async function waitUntilClosed(
  io: Pick<ModelPickerIo, "terminal" | "signal">,
  spec: ModelPickerSpec,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let streak = 0; ; await delay(clearReadingGapMs)) {
    io.signal?.throwIfAborted();
    streak = closing(spec, io.terminal.snapshot().text) ? 0 : streak + 1;
    if (streak >= clearReadings) return;
    if (Date.now() >= deadline)
      throw elwoodError(
        "model_automation_failed",
        `Timed out waiting for ${spec.agent} model picker to close.`,
      );
  }
}
