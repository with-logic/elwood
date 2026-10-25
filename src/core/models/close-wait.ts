/**
 * A model operation's close wait: the queue slot is released only once the operation's
 * dialog has stayed gone, not on the first frame that lacks it (PRD §5.3, C-API-55).
 */

import { delay } from "../delay.ts";
import { elwoodError } from "../errors.ts";
import { writeUnsafe } from "../input/abort.ts";
import { clearReadingGapMs, clearReadings } from "./clearance.ts";
import type { ModelPickerIo, ModelPickerSpec } from "./picker.ts";
import { ownOperation } from "./rows.ts";

/**
 * Whether the bottom-most region is still the operation's dialog: any stage of it, complete
 * or partly painted. Deliberately weaker than `isOwnCompletePicker`, because it only waits;
 * it never gates a write. Dialog text above a conversation or composer row (a transcript
 * quoting the picker's title) is not the dialog and does not hold the slot (C-API-55).
 */
const closing = (spec: ModelPickerSpec, text: string) =>
  spec.activeDialog(text, ownOperation) !== undefined || spec.isCandidate(text);

/**
 * Resolves once the dialog has not shown across `clearReadings` readings spaced
 * `clearReadingGapMs` apart; any reading that shows it restarts the count. One frame without
 * the picker is not proof it closed: a blank or half-painted repaint lacks it too, and the
 * picker can paint again after it, where a queued Enter released by this operation would
 * apply the highlighted model. Absence, not positive composer clearance, is what is counted:
 * clearance excludes a running turn, and model operations run during turns (C-API-35). A
 * reading that cannot first render everything received proves nothing, so it fails the wait
 * (C-API-56).
 */
export async function waitUntilClosed(
  io: Pick<ModelPickerIo, "terminal" | "signal">,
  spec: ModelPickerSpec,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let streak = 0; ; await delay(clearReadingGapMs)) {
    io.signal?.throwIfAborted();
    // Each reading is of everything received, like each picker key: a repaint still queued
    // for rendering would otherwise leave a stale blank frame to count (C-API-56).
    if (await writeUnsafe(io.terminal, undefined, io.signal)) {
      io.signal?.throwIfAborted();
      throw elwoodError(
        "model_automation_failed",
        `Could not confirm the ${spec.agent} model picker closed: its received output could not be rendered.`,
      );
    }
    streak = closing(spec, io.terminal.snapshot().text) ? 0 : streak + 1;
    if (streak >= clearReadings) return;
    if (Date.now() >= deadline)
      throw elwoodError(
        "model_automation_failed",
        `Timed out waiting for ${spec.agent} model picker to close.`,
      );
  }
}
