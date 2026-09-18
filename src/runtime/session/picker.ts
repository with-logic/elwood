/** Exclusive model-picker queue ownership and failure cleanup (PRD §5.3, C-API-55). */
import type { ControlQueue } from "../../core/control-queue/index.ts";
import { elwoodError } from "../../core/errors.ts";
import type { InputTerminal } from "../../core/input/abort.ts";
import type { ModelPickerIo, ModelPickerSpec } from "../../core/models/picker.ts";
import type { ScreenTerminal } from "../../core/models/tui-screen.ts";
import { abortable, cleanUpDialog, escapeKey, ours, type Progress } from "./picker-cleanup.ts";

type PickerDeps = {
  readonly controlQueue: ControlQueue;
  readonly submitDirect: (command: string, signal: AbortSignal) => Promise<void>;
  /** Also carries the optional observation barrier (`settled`/`renderFailed`) when real. */
  readonly terminal: ScreenTerminal & InputTerminal;
  readonly blocked: () => boolean;
};

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

  private async cleanUp(
    spec: ModelPickerSpec,
    progress: Progress,
    closed: AbortSignal,
  ): Promise<void> {
    const released = await cleanUpDialog(this.deps.terminal, spec, progress, closed);
    if (!released) this.survivor = spec;
  }
}
