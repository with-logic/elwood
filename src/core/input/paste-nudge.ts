/** Bound recovery observations separately from physical Enter attempts (PRD §5.3). */
import { type InputTerminal, writeUnsafe } from "./abort.ts";
import type { EmptyComposerObserver } from "./clear-ack.ts";
import { pasteNudgeAttempts, pasteObservationLimit } from "./constants.ts";
import type { PasteGuard } from "./index.ts";

export function preparePasteNudges(
  terminal: InputTerminal,
  guard: PasteGuard | undefined,
  payload: string,
  signal: AbortSignal | undefined,
  delayMs: number,
  priorEmptyFrame: ReturnType<EmptyComposerObserver>,
  revoked?: () => boolean,
) {
  if (!guard) return undefined;
  const staged =
    "prepareStaged" in guard
      ? guard.prepareStaged(payload)
      : () => guard.staged(guard.snapshot(), payload);
  let hasFreshFrame: (() => boolean) | undefined;
  const beforeEnter = () => {
    hasFreshFrame = guard.captureRenderProgress?.();
  };
  let attempts = 0;
  let observations = 0;
  const schedule = () => {
    const timer = setTimeout(nudge, delayMs);
    timer.unref?.();
  };
  const nudge = async () => {
    const unsafe = await writeUnsafe(terminal, guard, signal);
    // Later queued/raw input and native user_message revoke recovery authority.
    if (signal?.aborted || revoked?.()) return;
    observations += 1;
    if (unsafe) {
      if (observations < pasteObservationLimit) schedule();
      return;
    }
    const fresh = hasFreshFrame?.() !== false;
    const empty = guard.emptyFrame?.();
    // Geometry can replace an empty token without output; only post-Enter output retires input.
    if (fresh && empty && empty !== priorEmptyFrame) return;
    if (fresh && staged()) {
      attempts += 1;
      beforeEnter();
      await tryRecoveryEnter(terminal);
    } else if (!guard.emptyFrame) {
      // Write-only internal guards retain their boolean stopping contract.
      return;
    }
    if (attempts < pasteNudgeAttempts && observations < pasteObservationLimit) schedule();
  };
  return { beforeEnter, start: schedule };
}

async function tryRecoveryEnter(terminal: InputTerminal): Promise<void> {
  try {
    await terminal.sendInput("\r");
  } catch {
    // Recovery is best-effort after the initial Enter has dispatched.
  }
}
