/** Bounded staged-paste recovery; cancellation owns every Enter (PRD §5.3/§5.8). */
import { type InputTerminal, throwIfInputAborted, waitForInput, writeUnsafe } from "./abort.ts";
import type { PasteGuard } from "./index.ts";

export const pasteNudgeDelayMs = 1_000;
export const pasteNudgeAttempts = 2;

/**
 * True means the guard observed that this draft is no longer staged; false means
 * acceptance was not observed (no guard or exhausted attempts). verifyAcceptance
 * also observes the final Enter before returning, so replay cleanup stays owned.
 * Ordinary background nudges stop after their bounded writes without that final wait.
 */
export async function nudgePastedPrompt(
  terminal: InputTerminal,
  prompt: string,
  verifyAcceptance: boolean,
  guard?: PasteGuard,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!guard) return false;
  let nudges = 0;
  while (nudges < pasteNudgeAttempts || verifyAcceptance) {
    await waitForInput(pasteNudgeDelayMs, signal);
    // Recheck settled native output: a newly received dialog may not yet be rendered.
    const unsafe = await writeUnsafe(terminal, guard, signal);
    // Cancellation protects successor drafts: staged-chip markers are not prompt-specific.
    throwIfInputAborted(signal);
    // A dialog holds recovery without consuming its bounded Enter attempts.
    if (unsafe) continue;
    if (!guard.staged(guard.snapshot(), prompt)) return true;
    // Observe the final Enter too: writing it does not prove native acceptance.
    if (nudges === pasteNudgeAttempts) return false;
    nudges += 1;
    try {
      await terminal.sendInput("\r");
    } catch {
      // The first Enter landed; subsequent recovery writes remain best-effort.
    }
  }
  return false;
}
