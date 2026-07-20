/**
 * Claude image attachment: bracketed-paste each image's ABSOLUTE path into the
 * composer, the delivery a terminal produces on drag-and-drop. Claude reads and
 * encodes the file itself and shows an `[Image #N]` chip. Pure PTY text, so this
 * works on every platform. Implements PRD §5.3 (C-API-45).
 */

import { sanitizePasteText } from "../core/session-input.ts";

/** The terminal surface the attach needs: paste bytes and read the screen. */
export type AttachTerminal = {
  sendInput(data: string): void | Promise<void>;
  snapshot(): { readonly text: string };
};

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const settleMs = 150;
const pollMs = 100;
const attempts = 40; // ~4s per image before giving up and moving on

/** Matches Claude's `[Image #N]` composer chip; N grows as images are added. */
function imageChipCount(text: string): number {
  const matches = text.match(/\[Image #\d+\]/g);
  return matches ? matches.length : 0;
}

/**
 * Pastes each absolute path in order, waiting after each for the `[Image #N]`
 * chip count to increase so a slow read cannot let the next paste (or the text)
 * race ahead. A path is sanitized before framing so it cannot escape paste mode
 * (C-API-45). Best-effort: if a chip never appears the attach proceeds, so a
 * matcher drift never deadlocks a submission.
 */
export async function attachClaudeImages(
  terminal: AttachTerminal,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  for (const path of paths) {
    if (signal.aborted) return;
    const before = imageChipCount(terminal.snapshot().text);
    await terminal.sendInput(`${PASTE_START}${sanitizePasteText(path)}${PASTE_END}`);
    await waitForChip(terminal, before, signal);
  }
}

async function waitForChip(
  terminal: AttachTerminal,
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
