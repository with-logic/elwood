/**
 * Shared `[Image #N]` chip confirmation used by both adapter attach paths. An
 * attach is CONFIRMED only when the composer's image-chip count increases; an
 * unconfirmed image (timeout), or an abort (session closing), REJECTS with
 * `image_attach_failed` so no text is ever submitted for an unconfirmed image.
 * Implements PRD §5.3 (C-API-44/45/46).
 */

import { elwoodError } from "../errors.ts";

/** The terminal surface an attach needs: send bytes and read the rendered screen. */
export type AttachTerminal = {
  sendInput(data: string): void | Promise<void>;
  snapshot(): { readonly text: string };
};

export type ChipWaitOptions = {
  readonly settleMs: number;
  readonly timeoutMs: number;
  readonly pollMs: number;
};

/** Counts `[Image #N]` composer chips; N grows as images are added. */
export function imageChipCount(text: string): number {
  return text.match(/\[Image #\d+\]/g)?.length ?? 0;
}

/**
 * Resolves once the chip count rises above `before`; rejects with
 * `image_attach_failed` on the confirmation timeout or an aborted signal, so an
 * unconfirmed attach never silently degrades to a text-only turn.
 */
export async function waitForImageChip(
  terminal: AttachTerminal,
  before: number,
  signal: AbortSignal,
  options: ChipWaitOptions,
): Promise<void> {
  await delay(options.settleMs);
  const attempts = Math.max(1, Math.ceil(options.timeoutMs / options.pollMs));
  for (let i = 0; i < attempts; i++) {
    if (signal.aborted) throw elwoodError("image_attach_failed", "Image attach aborted.");
    if (imageChipCount(terminal.snapshot().text) > before) return;
    await delay(options.pollMs);
  }
  throw elwoodError("image_attach_failed", "Image attach was not confirmed before the timeout.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
