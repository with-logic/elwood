/**
 * Shared `[Image #N]` chip confirmation used by both adapter attach paths. An
 * attach is CONFIRMED only when the composer's image-chip count increases; an
 * unconfirmed image (timeout), or an abort (session closing), REJECTS with
 * `image_attach_failed` so no text is ever submitted for an unconfirmed image.
 * Implements PRD §5.3 (C-API-44/45/46/56).
 */

import { elwoodError } from "../errors.ts";
import { holdWhileUnsafe, type InputTerminal } from "../input/abort.ts";

/** The terminal surface an attach needs: send bytes and read the rendered screen. */
export type AttachTerminal = Pick<InputTerminal, "settled" | "renderFailed"> & {
  sendInput(data: string): void | Promise<void>;
  snapshot(): { readonly text: string };
};

/** True while a blocking human-decision dialog is on screen (C-API-37 safety). */
export type BlockedGuard = () => boolean;

// Ctrl+U (kill to line start) + Ctrl+K (kill to line end) discard the composer
// draft on both TUIs, clearing any staged image chips/paths.
const clearComposerKeys = "\u0015\u000b";

/**
 * Best-effort discard of any staged composer content (image chips, pasted paths)
 * after a mid-attach failure, so the rejected submission's images cannot leak
 * into a later caller's turn. Never throws (C-API-44).
 */
export async function clearComposer(terminal: AttachTerminal): Promise<void> {
  try {
    await terminal.sendInput(clearComposerKeys);
  } catch {
    // Best-effort: a clear failure must not replace the primary attach error.
  }
}

/**
 * Observes received output, then sends only once no blocking dialog is on screen — a
 * paste path or Ctrl+V must never reach a permission/trust dialog and alter a
 * human decision. Rejects with `image_attach_failed` if the signal aborts while
 * held (the session closed). Unobserved or failed renders remain held (C-API-56).
 */
export async function sendWhenUnblocked(
  terminal: AttachTerminal,
  data: string,
  blocked: BlockedGuard | undefined,
  signal: AbortSignal,
): Promise<void> {
  await holdWhileUnsafe(terminal, blocked === undefined ? undefined : { blocked }, signal);
  // Cancellation can arrive as the observation or dialog hold clears.
  if (signal.aborted) throw elwoodError("image_attach_failed", "Image attach aborted.");
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
