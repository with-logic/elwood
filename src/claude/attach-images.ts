/**
 * Claude image attachment: bracketed-paste each image's ABSOLUTE path into the
 * composer, the delivery a terminal produces on drag-and-drop. Claude reads and
 * encodes the file itself and shows an `[Image #N]` chip. Pure PTY text, so this
 * works on every platform. Each attach is confirmed by its chip or rejects.
 * Implements PRD §5.3 (C-API-45).
 */

import { elwoodError } from "../core/errors.ts";
import {
  type AttachTerminal,
  type BlockedGuard,
  type ChipWaitOptions,
  sendObservedImage,
  waitForImageChip,
} from "../core/images/chip-wait.ts";
import { requestComposerCleanup } from "../core/input/composer-cleanup.ts";
import { sanitizePasteText } from "../core/input/index.ts";

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const chipWait: ChipWaitOptions = { settleMs: 150, timeoutMs: 10_000, pollMs: 100 };

/**
 * Pastes each absolute path in order, waiting for the `[Image #N]` chip to
 * confirm before the next paste. A path is sanitized before framing so it cannot
 * escape paste mode, and each paste is held while a blocking dialog is on screen
 * so it never reaches a permission/trust dialog (C-API-37/45). An unconfirmed
 * chip or an abort rejects with `image_attach_failed`; a detected permanent render
 * failure rejects with that error immediately, without awaiting the confirmation
 * timeout. The caller submits no text.
 */
export async function attachClaudeImages(
  terminal: AttachTerminal,
  paths: readonly string[],
  signal: AbortSignal,
  blocked?: BlockedGuard,
): Promise<void> {
  let staged = false;
  try {
    for (const path of paths) {
      if (signal.aborted) throw elwoodError("image_attach_failed", "Image attach aborted.");
      const paste = `${PASTE_START}${sanitizePasteText(path)}${PASTE_END}`;
      const before = await sendObservedImage(terminal, paste, blocked, signal);
      staged = true;
      await waitForImageChip(terminal, before, signal, chipWait);
    }
  } catch (error) {
    // The session owner defers cleanup until attachment/temp-file finalizers settle and input is safe.
    // Direct unregistered callers make an observed, unblocked best-effort request (C-API-44).
    if (staged) await requestComposerCleanup(terminal, blocked);
    throw error;
  }
}
