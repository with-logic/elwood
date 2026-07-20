/**
 * Codex image attachment: Codex ingests an interactive image only from the OS
 * clipboard via Ctrl+V (it reads `public.tiff` off the macOS NSPasteboard), so
 * for each image Elwood snapshots the clipboard, writes the image onto it, sends
 * Ctrl+V, and waits for the `[Image #N]` chip — then restores the snapshotted
 * clipboard. macOS-only. Implements PRD §5.3 (C-API-46).
 */

import { elwoodError } from "../core/errors.ts";
import {
  clipboardImageSupported,
  restoreClipboardText,
  setClipboardImage,
  snapshotClipboardText,
} from "../core/images/index.ts";

/** The terminal surface the attach needs: send the paste key and read the screen. */
export type CodexAttachTerminal = {
  sendInput(data: string): void | Promise<void>;
  snapshot(): { readonly text: string };
};

const CTRL_V = "\u0016"; // Ctrl+V triggers Codex clipboard-image paste
const settleMs = 200;
const pollMs = 100;
const attempts = 40; // ~4s per image before giving up and moving on

/** Counts Codex's `[Image #N]` composer chips; N grows as images are added. */
function imageChipCount(text: string): number {
  const matches = text.match(/\[Image #\d+\]/g);
  return matches ? matches.length : 0;
}

/**
 * Attaches every image via the clipboard, restoring the user's clipboard text
 * afterward (best-effort). Rejects with `unsupported_platform` on non-macOS
 * BEFORE touching the clipboard, so nothing is pasted there (C-API-46). A
 * per-image `setClipboardImage` failure rejects with `invalid_image`; the
 * clipboard is still restored via the finally.
 */
export async function attachCodexImages(
  terminal: CodexAttachTerminal,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (!clipboardImageSupported())
    throw elwoodError("unsupported_platform", "Codex image attachment requires macOS.");
  const priorClipboard = snapshotClipboardText();
  try {
    for (const path of paths) {
      if (signal.aborted) return;
      const before = imageChipCount(terminal.snapshot().text);
      setClipboardImage(path);
      await terminal.sendInput(CTRL_V);
      await waitForChip(terminal, before, signal);
    }
  } finally {
    restoreClipboardText(priorClipboard);
  }
}

async function waitForChip(
  terminal: CodexAttachTerminal,
  before: number,
  signal: AbortSignal,
): Promise<void> {
  await delay(settleMs);
  for (let i = 0; i < attempts; i++) {
    if (signal.aborted) return;
    if (imageChipCount(terminal.snapshot().text) > before) return;
    await delay(pollMs);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
