/**
 * Shared `[Image #N]` chip confirmation used by both adapter attach paths. An
 * attach is CONFIRMED only when the composer's image-chip count increases; an
 * unconfirmed image (timeout) or abort (session closing) REJECTS with
 * `image_attach_failed`. A detected permanent render failure rejects immediately
 * with that error, without waiting for confirmation timeout. No text is submitted
 * for an unconfirmed image.
 * Implements PRD §5.3 (C-API-44/45/46/56).
 */

import { elwoodError } from "../errors.ts";
import { type InputTerminal, writeUnsafe } from "../input/abort.ts";
import { stageComposer } from "../input/composer-cleanup.ts";
import { unsafeWriteRetryMs } from "../input/constants.ts";

/** The terminal surface an attach needs: send bytes and read the rendered screen. */
export type AttachTerminal = Required<Pick<InputTerminal, "settled" | "renderFailed">> & {
  sendInput(data: string): void | Promise<void>;
  snapshot(): { readonly text: string };
};

/** True while a blocking human-decision dialog is on screen (C-API-37 safety). */
export type BlockedGuard = () => boolean;

/**
 * Observe received output and wait for dialogs before an image key. Capture the
 * chip baseline in the same turn as that key, so the observation cannot confirm
 * this image using an older chip. Cancellation or permanent render failure rejects
 * with `image_attach_failed`; a failed Codex session must release its clipboard lease.
 */
export async function sendObservedImage(
  terminal: AttachTerminal,
  data: string,
  blocked: BlockedGuard | undefined,
  signal: AbortSignal,
): Promise<number> {
  const guard = blocked === undefined ? undefined : { blocked };
  for (;;) {
    assertAttachNotAbortedOrRenderFailed(terminal, signal);
    const unsafe = await writeUnsafe(terminal, guard, signal);
    assertAttachNotAbortedOrRenderFailed(terminal, signal);
    if (!unsafe) break;
    await delay(unsafeWriteRetryMs);
  }
  const before = imageChipCount(terminal.snapshot().text);
  stageComposer(terminal);
  await terminal.sendInput(data);
  return before;
}

function assertAttachNotAbortedOrRenderFailed(terminal: AttachTerminal, signal: AbortSignal): void {
  if (signal.aborted) throw elwoodError("image_attach_failed", "Image attach aborted.");
  if (terminal.renderFailed)
    throw elwoodError(
      "image_attach_failed",
      "Image attach cannot observe a failed terminal render.",
    );
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
 * unconfirmed attach never silently degrades to a text-only turn. A detected permanent
 * render failure rejects immediately with that error rather than awaiting the timeout.
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
    assertAttachNotAbortedOrRenderFailed(terminal, signal);
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
