/** Bounded staged-paste recovery; cancellation owns every Enter (PRD §5.3/§5.8). */
import { type InputTerminal, throwIfInputAborted, waitForInput, writeUnsafe } from "./abort.ts";
import type { PasteGuard } from "./index.ts";

export const pasteNudgeDelayMs = 1_000;
export const pasteNudgeAttempts = 2;

export async function nudgePastedPrompt(
  terminal: InputTerminal,
  prompt: string,
  guard?: PasteGuard,
  signal?: AbortSignal,
): Promise<void> {
  if (!guard) return;
  let nudges = 0;
  while (nudges < pasteNudgeAttempts) {
    await waitForInput(pasteNudgeDelayMs, signal);
    // Recheck settled native output: a newly received dialog may not yet be rendered.
    const unsafe = await writeUnsafe(terminal, guard, signal);
    // Cancellation protects successor drafts: staged-chip markers are not prompt-specific.
    throwIfInputAborted(signal);
    // A dialog holds recovery without consuming its bounded Enter attempts.
    if (unsafe) continue;
    if (!guard.staged(guard.snapshot(), prompt)) return;
    nudges += 1;
    try {
      await terminal.sendInput("\r");
    } catch {
      // The first Enter landed; subsequent recovery writes remain best-effort.
    }
  }
}
