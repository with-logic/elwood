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
  type ChipWaitOptions,
  imageChipCount,
  waitForImageChip,
} from "../core/images/chip-wait.ts";
import { sanitizePasteText } from "../core/session-input.ts";

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const chipWait: ChipWaitOptions = { settleMs: 150, timeoutMs: 10_000, pollMs: 100 };

/**
 * Pastes each absolute path in order, waiting for the `[Image #N]` chip to
 * confirm before the next paste. A path is sanitized before framing so it cannot
 * escape paste mode (C-API-45). An unconfirmed chip or an abort rejects with
 * `image_attach_failed`; the caller then submits no text.
 */
export async function attachClaudeImages(
  terminal: AttachTerminal,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  for (const path of paths) {
    if (signal.aborted) throw elwoodError("image_attach_failed", "Image attach aborted.");
    const before = imageChipCount(terminal.snapshot().text);
    await terminal.sendInput(`${PASTE_START}${sanitizePasteText(path)}${PASTE_END}`);
    await waitForImageChip(terminal, before, signal, chipWait);
  }
}
