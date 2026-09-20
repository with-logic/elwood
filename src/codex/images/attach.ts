/**
 * Codex image attachment: Codex ingests an interactive image only from the OS
 * clipboard via Ctrl+V (it reads `public.tiff` off the macOS NSPasteboard), so
 * Elwood snapshots the clipboard TEXT once (only text is captured), then for each
 * image sets it + Ctrl+V + waits for the `[Image #N]` chip, then restores the text
 * snapshot. macOS-only, and
 * the whole transaction holds a process-wide clipboard lock so concurrent Codex
 * sessions cannot cross-attach. Implements PRD §5.3 (C-API-46).
 */

import { elwoodError } from "../../core/errors.ts";
import { requestComposerCleanup } from "../../core/input/composer-cleanup.ts";
import {
  type AttachTerminal,
  type BlockedGuard,
  type ChipWaitOptions,
  sendObservedImage,
  waitForImageChip,
} from "../../core/images/chip-wait.ts";
import {
  clipboardImageSupported,
  restoreClipboardText,
  setClipboardImage,
  snapshotClipboardText,
} from "./clipboard.ts";
import { withClipboardLock } from "./clipboard-lock.ts";

const CTRL_V = "\u0016"; // Ctrl+V triggers Codex clipboard-image paste
const chipWait: ChipWaitOptions = { settleMs: 200, timeoutMs: 10_000, pollMs: 100 };

/**
 * Attaches every image via the clipboard under a process-wide lock, restoring
 * the user's clipboard text afterward (best-effort). Rejects with
 * `unsupported_platform` on non-macOS BEFORE touching the clipboard, and with
 * `image_attach_failed`/`invalid_image` on a snapshot/set/confirm failure; the
 * caller then submits no text. A detected permanent render failure rejects with
 * `image_attach_failed` immediately, without awaiting the confirmation timeout.
 * The Ctrl+V is held while a blocking dialog is on
 * screen so it never confirms a dialog (C-API-37/46).
 */
export async function attachCodexImages(
  terminal: AttachTerminal,
  paths: readonly string[],
  signal: AbortSignal,
  blocked?: BlockedGuard,
  onRestoreFailed?: () => void,
): Promise<void> {
  if (!clipboardImageSupported())
    throw elwoodError("unsupported_platform", "Codex image attachment requires macOS.");
  await withClipboardLock(
    () => attachUnderLock(terminal, paths, signal, blocked, onRestoreFailed),
    { signal, error: () => elwoodError("image_attach_failed", "Image attach aborted.") },
  );
}

async function attachUnderLock(
  terminal: AttachTerminal,
  paths: readonly string[],
  signal: AbortSignal,
  blocked: BlockedGuard | undefined,
  onRestoreFailed: (() => void) | undefined,
): Promise<void> {
  // Snapshot BEFORE mutating; a snapshot failure rejects here so we never
  // overwrite then "restore" an empty string over the user's clipboard.
  const priorClipboard = await snapshotClipboardText();
  let staged = false;
  try {
    for (const path of paths) {
      await setClipboardImage(path);
      // sendObservedImage rejects if the signal is already aborted, so a mid-attach
      // close is caught here before the Ctrl+V reaches the PTY (C-API-46).
      const before = await sendObservedImage(terminal, CTRL_V, blocked, signal);
      staged = true;
      await waitForImageChip(terminal, before, signal, chipWait);
    }
  } catch (error) {
    // Request now; the session owner clears only after this clipboard finalizer and safe input.
    if (staged) await requestComposerCleanup(terminal, blocked);
    throw error;
  } finally {
    // Best-effort and fully isolated: neither the restore nor its warning callback
    // may reject or mask the primary attach result/error (C-API-46).
    try {
      if (!(await restoreClipboardText(priorClipboard))) onRestoreFailed?.();
    } catch {
      // A throwing warning sink must not turn a successful attach into a failure.
    }
  }
}
