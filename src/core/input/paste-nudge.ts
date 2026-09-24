/** Bound recovery observations separately from physical Enter attempts (PRD §5.3). */
import { type InputTerminal, writeUnsafe } from "./abort.ts";
import { pasteNudgeAttempts } from "./constants.ts";
import type { PasteGuard } from "./index.ts";

export function schedulePasteNudges(
  terminal: InputTerminal,
  guard: PasteGuard | undefined,
  payload: string,
  signal: AbortSignal | undefined,
  delayMs: number,
  priorEmptyFrame: object | undefined,
  revoked?: () => boolean,
): void {
  if (!guard) return;
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
      if (observations < 4) schedule();
      return;
    }
    const empty = guard.emptyFrame?.();
    if (empty && empty !== priorEmptyFrame) return;
    if (guard.staged(guard.snapshot(), payload)) {
      attempts += 1;
      await tryRecoveryEnter(terminal);
    } else if (!guard.emptyFrame) {
      // Write-only internal guards retain their boolean stopping contract.
      return;
    }
    if (attempts < pasteNudgeAttempts && observations < 4) schedule();
  };
  schedule();
}

async function tryRecoveryEnter(terminal: InputTerminal): Promise<void> {
  try {
    await terminal.sendInput("\r");
  } catch {
    // Recovery is best-effort after the initial Enter has dispatched.
  }
}
