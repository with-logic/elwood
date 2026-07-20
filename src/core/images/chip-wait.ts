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

/** True while a blocking human-decision dialog is on screen (C-API-37 safety). */
export type BlockedGuard = () => boolean;

const blockedPollMs = 50;

/**
 * Sends `data` to the terminal only once no blocking dialog is on screen — a
 * paste path or Ctrl+V must never reach a permission/trust dialog and alter a
 * human decision. Rejects with `image_attach_failed` if the signal aborts while
 * held (the session closed) (C-API-37/44).
 */
export async function sendWhenUnblocked(
  terminal: AttachTerminal,
  data: string,
  blocked: BlockedGuard | undefined,
  signal: AbortSignal,
): Promise<void> {
  while (blocked?.()) {
    if (signal.aborted) throw elwoodError("image_attach_failed", "Image attach aborted.");
    await delay(blockedPollMs);
  }
  await terminal.sendInput(data);
}

export type ChipWaitOptions = {
  readonly settleMs: number;
  readonly timeoutMs: number;
  readonly pollMs: number;
};

// Both CLIs render the image chip on the composer PROMPT line (Codex `›`, Claude
// `❯`), e.g. `› [Image #1]`. Counting chips only on lines bearing a prompt marker
// means assistant/tool/transcript output elsewhere that happens to contain a
// literal `[Image #N]` cannot spoof a confirmation (C-API-44/45/46).
const promptLine = /^[^\S\r\n]*[›❯]/;
const chip = /\[Image #\d+\]/g;

/** Counts `[Image #N]` chips on the composer prompt line(s) only. */
export function imageChipCount(text: string): number {
  return text
    .split("\n")
    .filter((line) => promptLine.test(line))
    .reduce((sum, line) => sum + (line.match(chip)?.length ?? 0), 0);
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
