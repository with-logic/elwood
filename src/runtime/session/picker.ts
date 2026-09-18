/** Exclusive model-picker queue ownership and failure cleanup (PRD §5.3, C-API-55). */
import type { ControlQueue } from "../../core/control-queue/index.ts";
import { delay } from "../../core/delay.ts";
import { elwoodError } from "../../core/errors.ts";
import { sendPickerInput } from "../../core/models/input.ts";
import type { ModelPickerIo, ModelPickerSpec } from "../../core/models/picker.ts";
import type { ModelDialogAuthority, ModelDialogStage } from "../../core/models/rows.ts";
import type { ScreenTerminal } from "../../core/models/tui-screen.ts";

type PickerDeps = {
  readonly controlQueue: ControlQueue;
  readonly submitDirect: (command: string, signal: AbortSignal) => Promise<void>;
  readonly terminal: ScreenTerminal;
  readonly blocked: () => boolean;
};

/** What the operation wrote and saw, so cleanup knows what it may repeat and what can still paint. */
type Progress = {
  /** The stage the operation itself last sent Escape to, which cleanup must not repeat. */
  escapeSentTo: ModelDialogStage | undefined;
  commandSubmitted: boolean;
  dialogSeen: boolean;
  /** A non-Escape key can accept a stage whose follow-up dialog paints late. */
  keyWritten: boolean;
};
const cleanupMs = 1_000;
const pollMs = 100;
const escapeKey = "\u001b";
/**
 * Every recognition call in this file is made from inside a transaction Elwood opened (or,
 * for `blocksInput`, about a dialog that transaction left behind), so all of them carry
 * authority. It is a named constant rather than an inline literal so that a future call
 * site added OUTSIDE a transaction has to reach for it deliberately.
 */
const ours: ModelDialogAuthority = { opened: true };

export class PickerTransactions {
  private readonly deps: PickerDeps;
  private survivor: ModelPickerSpec | undefined;
  constructor(deps: PickerDeps) {
    this.deps = deps;
  }

  /** Whether a dialog that outlived cleanup is still visible; forgets it once it clears. */
  blocksInput(): boolean {
    // `survivor` is only set by our OWN cleanup, so this dialog is one we opened: the
    // authority that outlived the transaction is what still makes it ours to hold on.
    if (this.survivor?.activeDialog(this.deps.terminal.snapshot().text, ours) !== undefined)
      return true;
    this.survivor = undefined;
    return false;
  }

  /**
   * Runs `work` inside one exclusive queue slot, so no other command or message is
   * dispatched until the whole open/navigate/apply-or-cancel flow settles. The queue
   * wait and the flow share `timeoutMs`; the deadline or session close aborts `io`.
   * A failed flow's dialog is cancelled before the slot is released.
   */
  async run<T>(
    kind: "list_models" | "set_model",
    spec: ModelPickerSpec,
    timeoutMs: number,
    work: (io: ModelPickerIo) => Promise<T>,
  ): Promise<T> {
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          elwoodError("model_automation_failed", "Timed out waiting for model picker operation."),
        ),
      timeoutMs,
    );
    let result!: T;
    try {
      await this.deps.controlQueue.runExclusive(
        kind,
        async (closed) => {
          // Elwood cannot tell its own dialog from picker text that precedes its command: a
          // human's dialog, or a transcript quote the unanchored `isOpen` would drive.
          const before = this.deps.terminal.snapshot().text;
          // We have NOT written `/model` yet, so nothing here is ours. We still ask the
          // grammar under a hypothetical authority: anything it would call a dialog is
          // someone else's, which is precisely why the operation must refuse to start.
          if (spec.isOpen(before) || spec.activeDialog(before, ours) !== undefined)
            throw elwoodError(
              "model_automation_failed",
              "Model picker text was already visible before the operation began.",
            );
          const progress: Progress = {
            escapeSentTo: undefined,
            commandSubmitted: false,
            dialogSeen: false,
            keyWritten: false,
          };
          const signal = AbortSignal.any([closed, deadline.signal]);
          try {
            result = await work(this.io(signal, spec, progress));
          } catch (error) {
            if (!closed.aborted) await this.cleanUp(spec, progress, closed);
            throw error;
          }
        },
        { signal: deadline.signal, error: () => deadline.signal.reason },
      );
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private io(signal: AbortSignal, spec: ModelPickerSpec, progress: Progress): ModelPickerIo {
    const live = abortable(this.deps.terminal, signal);
    const terminal: ScreenTerminal = {
      snapshot: () => {
        const snapshot = live.snapshot();
        progress.dialogSeen ||= spec.activeDialog(snapshot.text, ours) !== undefined;
        return snapshot;
      },
      sendInput: (input) => {
        const stage = spec.activeDialog(live.snapshot().text, ours);
        const sent = live.sendInput(input);
        if (input === escapeKey) progress.escapeSentTo = stage;
        else progress.keyWritten = true;
        return sent;
      },
    };
    return {
      terminal,
      signal,
      blocked: this.deps.blocked,
      // The slot already owns the queue, so the command is written directly.
      submit: (command, pending) => {
        signal.throwIfAborted();
        progress.commandSubmitted = true;
        return this.deps.submitDirect(command, AbortSignal.any([signal, pending]));
      },
    };
  }

  /**
   * One bounded second covers a late dialog appearing, every Escape, and the clearing.
   * A submitted command whose picker never rendered can still open it, and an accepted
   * stage can still paint its follow-up, so cleanup then waits out the bound for one.
   * Cancelling a follow-up stage returns the CLI to the picker (real Claude 2.1.274 and
   * Codex 0.154.0), so each stage gets one Escape and none is repeated while that stage
   * stays up: a second Escape on a slow repaint would land on the composer. A `painting`
   * shell is never written to. Termination aborts every read and write. A dialog still
   * visible at the bound keeps queued input held.
   */
  private async cleanUp(
    spec: ModelPickerSpec,
    progress: Progress,
    closed: AbortSignal,
  ): Promise<void> {
    const terminal = abortable(this.deps.terminal, closed);
    const isActive = (text: string) => spec.activeDialog(text, ours) !== undefined;
    let escaped = progress.escapeSentTo;
    let lateDialogPossible =
      progress.keyWritten || (progress.commandSubmitted && !progress.dialogSeen);
    try {
      for (const bound = Date.now() + cleanupMs; Date.now() < bound; await delay(pollMs)) {
        const stage = spec.activeDialog(terminal.snapshot().text, ours);
        if (stage === undefined) {
          if (!lateDialogPossible) return;
          // Whatever paints after a clear frame is a new dialog, owed its own Escape.
          escaped = undefined;
          continue;
        }
        lateDialogPossible = false;
        // A `painting` shell may turn out to be a hook confirmation: wait, never write.
        if (stage === "painting" || stage === escaped) continue;
        escaped = stage;
        await sendPickerInput({ terminal }, escapeKey, isActive, true);
      }
    } catch {
      // A terminated session has no input left to hold; a failed write leaves the dialog.
      if (closed.aborted) return;
    }
    if (!lateDialogPossible) this.survivor = spec;
  }
}

/** Reads and writes throw once `signal` aborts, so nothing reaches a terminated PTY. */
function abortable(terminal: ScreenTerminal, signal: AbortSignal): ScreenTerminal {
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
