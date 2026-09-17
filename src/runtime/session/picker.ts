/** Exclusive model-picker queue ownership and failure cleanup (PRD §5.3, C-API-55). */
import type { ControlQueue } from "../../core/control-queue/index.ts";
import { delay } from "../../core/delay.ts";
import { elwoodError } from "../../core/errors.ts";
import { sendPickerInput } from "../../core/models/input.ts";
import type { ModelPickerIo, ModelPickerSpec } from "../../core/models/picker.ts";
import type { ModelDialogStage } from "../../core/models/rows.ts";
import type { ScreenTerminal } from "../../core/models/tui-screen.ts";

type PickerDeps = {
  readonly controlQueue: ControlQueue;
  readonly submitDirect: (command: string, signal: AbortSignal) => Promise<void>;
  readonly terminal: ScreenTerminal;
  readonly blocked: () => boolean;
};

/** The stage the operation itself last sent Escape to, which cleanup must not repeat. */
type Progress = { escapeSentTo: ModelDialogStage | undefined };
const cleanupMs = 1_000;
const pollMs = 100;
const escapeKey = "\u001b";

export class PickerTransactions {
  private readonly deps: PickerDeps;
  private survivor: ModelPickerSpec | undefined;
  constructor(deps: PickerDeps) {
    this.deps = deps;
  }

  /** Whether a dialog that outlived cleanup is still visible; forgets it once it clears. */
  blocksInput(): boolean {
    if (this.survivor?.activeDialog(this.deps.terminal.snapshot().text) !== undefined) return true;
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
          const progress: Progress = { escapeSentTo: undefined };
          const signal = AbortSignal.any([closed, deadline.signal]);
          try {
            result = await work(this.io(signal, spec, progress));
          } catch (error) {
            if (!closed.aborted) await this.cleanUp(spec, progress.escapeSentTo, closed);
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
      snapshot: live.snapshot,
      sendInput: (input) => {
        if (input === escapeKey) progress.escapeSentTo = spec.activeDialog(live.snapshot().text);
        return live.sendInput(input);
      },
    };
    return {
      terminal,
      signal,
      blocked: this.deps.blocked,
      // The slot already owns the queue, so the command is written directly.
      submit: (command, pending) =>
        this.deps.submitDirect(command, AbortSignal.any([signal, pending])),
    };
  }

  /**
   * One bounded second covers every Escape and the dialog clearing. Cancelling a
   * follow-up stage returns the CLI to the picker (real Claude 2.1.274 and Codex
   * 0.154.0), so each stage gets one Escape and none is repeated: a second Escape
   * on a slow repaint would land on the composer. Termination aborts every read
   * and write. A dialog still visible at the bound keeps queued input held.
   */
  private async cleanUp(
    spec: ModelPickerSpec,
    escapeSentTo: ModelDialogStage | undefined,
    closed: AbortSignal,
  ): Promise<void> {
    const terminal = abortable(this.deps.terminal, closed);
    const isActive = (text: string) => spec.activeDialog(text) !== undefined;
    let escaped = escapeSentTo;
    try {
      for (const bound = Date.now() + cleanupMs; Date.now() < bound; await delay(pollMs)) {
        const stage = spec.activeDialog(terminal.snapshot().text);
        if (stage === undefined) return;
        // A `painting` shell may turn out to be a hook confirmation: wait, never write.
        if (stage === "painting" || stage === escaped) continue;
        escaped = stage;
        await sendPickerInput({ terminal }, escapeKey, isActive, true);
      }
    } catch {
      // A terminated session has no input left to hold; a failed write leaves the dialog.
      if (closed.aborted) return;
    }
    this.survivor = spec;
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
