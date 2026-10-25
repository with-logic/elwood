/** Revalidate the active picker immediately before automation writes (PRD §5.3, C-API-23/24/56). */

import { elwoodError } from "../errors.ts";
import { writeUnsafe } from "../input/abort.ts";
import type { ModelPickerIo } from "./picker.ts";

/**
 * Writes one picker key, decided on everything RECEIVED rather than the last rendered frame:
 * a permission or hook prompt can already be in the PTY buffer while the snapshot still shows
 * the picker, and a key chosen from that stale frame would change the prompt's selection.
 * `writeUnsafe` first renders and observes all received output; when the screen cannot be
 * vouched for, the key is withheld and the operation fails. Otherwise the dialog is
 * revalidated on that observed frame and the key is written before further output arrives.
 */
export async function sendPickerInput(
  io: Pick<ModelPickerIo, "terminal" | "blocked" | "signal">,
  input: string,
  expected: (text: string) => boolean,
  ownsBlockingDialog = false,
): Promise<void> {
  if (await writeUnsafe(io.terminal, undefined, io.signal)) {
    io.signal?.throwIfAborted();
    throw elwoodError(
      "model_automation_failed",
      "The model picker screen could not be verified before input could be sent.",
    );
  }
  if ((!ownsBlockingDialog && io.blocked?.()) || !expected(io.terminal.snapshot().text)) {
    throw elwoodError(
      "model_automation_failed",
      "The model picker was replaced before input could be sent.",
    );
  }
  return io.terminal.sendInput(input);
}
