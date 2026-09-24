/** Bounded recovery needs fresh staged input and no native acceptance (PRD §5.3). */
import { type InputTerminal, writeUnsafe } from "./abort.ts";
import { type PasteGuard, pasteNudgeAttempts } from "./index.ts";

export type RecoveryObservation = {
  readonly revoked: () => boolean;
  readonly frame: () => object | undefined;
};

export function pasteRecovery(
  terminal: InputTerminal,
  guard: PasteGuard | undefined,
  payload: string,
  signal: AbortSignal | undefined,
  delayMs: number,
) {
  const observed = guard?.recovery?.();
  let priorFrame: object | undefined;
  let attempts = 0;
  const beforeEnter = () => {
    priorFrame = observed?.frame();
  };
  const schedule = () => {
    const timer = setTimeout(nudge, delayMs);
    timer.unref?.();
  };
  const nudge = async () => {
    const unsafe = await writeUnsafe(terminal, guard, signal);
    if (signal?.aborted || observed?.revoked() || !guard || attempts >= pasteNudgeAttempts) return;
    if (observed) attempts += 1;
    if (unsafe) {
      schedule();
      return;
    }
    if (!observed) attempts += 1;
    const frame = observed?.frame();
    if (observed && (frame === undefined || frame === priorFrame)) {
      schedule();
      return;
    }
    if (!guard.staged(guard.snapshot(), payload)) return;
    beforeEnter();
    try {
      await terminal.sendInput("\r");
    } catch {
      /* First dispatch already settled. */
    }
    schedule();
  };
  return { beforeEnter, start: schedule };
}
