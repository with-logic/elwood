/**
 * Failure cleanup for a model-picker transaction: cancel the dialog the operation left
 * open, or report that one survived so queued input stays held (PRD §5.3, C-API-55).
 */
import { delay } from "../../core/delay.ts";
import { type InputTerminal, writeUnsafe } from "../../core/input/abort.ts";
import { sendPickerInput } from "../../core/models/input.ts";
import type { ModelPickerSpec } from "../../core/models/picker.ts";
import type { ModelDialogAuthority, ModelDialogStage } from "../../core/models/rows.ts";
import type { ScreenTerminal } from "../../core/models/tui-screen.ts";

/** What the operation wrote and saw, so cleanup knows what it may repeat and what can still paint. */
export type Progress = {
  /** The stage the operation itself last sent Escape to, which cleanup must not repeat. */
  escapeSentTo: ModelDialogStage | undefined;
  commandSubmitted: boolean;
  dialogSeen: boolean;
  /** A non-Escape key can accept a stage whose follow-up dialog paints late. */
  keyWritten: boolean;
};

const cleanupMs = 1_000;
/**
 * Consecutive clear frames that prove a dialog is gone rather than mid-repaint.
 *
 * Matches `quietFramesToSettle` in `core/turn-state.ts`, deliberately. That value IS
 * measured: Codex's resume replay repaints in bursts with brief 1-frame quiet gaps, and 5
 * clears them with margin (docs/cli-behavior.md, C-TURN-03). Picker repaints are the same
 * class of problem — a dialog redrawing between stages is briefly unrecognizable — and we
 * have NOT measured their gap length, so there is no evidence for a smaller number.
 *
 * The failure directions are not symmetric, which settles it. Too high only delays
 * releasing the input hold. Too low releases queued input into a repainting picker, where
 * Enter applies the highlighted model — the exact bug class this file exists to prevent.
 * Absent a measurement, take the conservative measured precedent.
 *
 * This governs the SURVIVOR hold in `picker.ts`, which is unbounded and only observes, so
 * a longer streak costs nothing but a little latency. The cleanup loop below uses a
 * shorter one on purpose: see `cleanupClearFrames`.
 */
export const clearFrames = 5;

/**
 * Cleanup's own streak, deliberately shorter than `clearFrames`.
 *
 * Cleanup is BOUNDED at one second and must also send its Escapes inside that budget, so
 * demanding five clear frames (500 ms at a 100 ms poll) would spend half the budget
 * proving a clearance it has already driven. It is also the safer of the two positions:
 * a cleanup that returns early only hands off to the survivor hold, which then applies
 * the full `clearFrames` streak before releasing any input. Nothing is released early.
 */
const cleanupClearFrames = 2;
const pollMs = 100;
export const escapeKey = "\u001b";
/**
 * Cleanup only ever runs for a dialog the transaction itself opened, so every recognition
 * call here carries its authority. Named rather than inlined so a future call site added
 * OUTSIDE a transaction has to reach for it deliberately.
 */
export const ours: ModelDialogAuthority = { opened: true };

/**
 * Returns whether the queue is RELEASED: true when the dialog is gone (or never appeared),
 * false when one survived cleanup and must keep holding queued input.
 *
 * One bounded second covers a late dialog appearing, every Escape, and the clearing.
 * A submitted command whose picker never rendered can still open it, and an accepted
 * stage can still paint its follow-up, so cleanup then waits out the bound for one.
 * Cancelling a follow-up stage returns the CLI to the picker (real Claude 2.1.274 and
 * Codex 0.154.0), so each stage gets one Escape and none is repeated while that stage
 * stays up: a second Escape on a slow repaint would land on the composer. A `painting`
 * shell is never written to. Termination aborts every read and write. A dialog still
 * visible at the bound keeps queued input held.
 */
export async function cleanUpDialog(
  source: ScreenTerminal & InputTerminal,
  spec: ModelPickerSpec,
  progress: Progress,
  closed: AbortSignal,
): Promise<boolean> {
  const terminal = abortable(source, closed);
  const isActive = (text: string) => spec.activeDialog(text, ours) !== undefined;
  let escaped = progress.escapeSentTo;
  let clearStreak = 0;
  /** Whether a dialog of ours was ever on screen here; only then can a clear frame lie. */
  let sawDialog = progress.escapeSentTo !== undefined;
  let lateDialogPossible =
    progress.keyWritten || (progress.commandSubmitted && !progress.dialogSeen);
  try {
    for (const bound = Date.now() + cleanupMs; Date.now() < bound; await delay(pollMs)) {
      const stage = spec.activeDialog(terminal.snapshot().text, ours);
      if (stage === undefined) {
        // ONE clear frame is not proof a dialog we were CANCELLING is gone: a picker
        // repainting between stages is momentarily unrecognizable, and releasing the queue
        // there would let queued input land in the frame that follows. So a streak is
        // required only once we have actually seen a dialog here; a cleanup that never
        // found one has nothing to repaint and returns at once. (Same lesson as resume
        // settling in docs/cli-behavior.md.)
        clearStreak += 1;
        const settled = !sawDialog || clearStreak >= cleanupClearFrames;
        // The dialog is gone and nothing can still paint: the queue is released.
        if (!lateDialogPossible && settled) return true;
        // Whatever paints after a clear frame is a new dialog, owed its own Escape.
        escaped = undefined;
        continue;
      }
      clearStreak = 0;
      sawDialog = true;
      lateDialogPossible = false;
      // A `painting` shell may turn out to be a hook confirmation: wait, never write.
      if (stage === "painting" || stage === escaped) continue;
      escaped = stage;
      // Decide the WRITE on everything received, not the last rendered frame: a permission
      // or hook dialog can already be in the PTY buffer while the observed screen still
      // shows the picker, and an Escape chosen from that stale frame would dismiss it.
      // `writeUnsafe` fails closed, so an unvouchable screen skips this Escape and the
      // next poll re-decides rather than writing blind (C-API-56).
      if (await writeUnsafe(source, undefined, closed)) continue;
      await sendPickerInput({ terminal }, escapeKey, isActive, true);
    }
  } catch {
    // A terminated session has no input left to hold; a failed write leaves the dialog.
    if (closed.aborted) return true;
  }
  // The bound elapsed with a dialog still on screen (or one that could still paint and
  // never did). A dialog we could not cancel SURVIVES, and queued input stays held on it;
  // `lateDialogPossible` means none ever appeared, so there is nothing to hold.
  return lateDialogPossible;
}
/** Reads and writes throw once `signal` aborts, so nothing reaches a terminated PTY. */
export function abortable(terminal: ScreenTerminal, signal: AbortSignal): ScreenTerminal {
  return {
    snapshot: () => {
      signal.throwIfAborted();
      return terminal.snapshot();
    },
    sendInput: (input) => {
      signal.throwIfAborted();
      return terminal.sendInput(input);
    },
  };
}
