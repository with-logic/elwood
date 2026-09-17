/** Exclusive model-picker queue ownership and cleanup (PRD §5.3, C-API-55). */
import type { ControlQueue } from "../../core/control-queue/index.ts";
import { elwoodError } from "../../core/errors.ts";
import { sendPickerInput } from "../../core/models/input.ts";
import type { ModelPickerIo, ModelPickerSpec } from "../../core/models/picker.ts";
import { type ScreenTerminal, waitForScreen } from "../../core/models/tui-screen.ts";

type PickerDeps = {
  readonly controlQueue: ControlQueue;
  readonly submitDirect: (command: string, signal: AbortSignal) => Promise<void>;
  readonly terminal: ScreenTerminal;
  readonly blocked: () => boolean;
};

type Progress = { submitted: boolean; dialog: boolean };
const recoveryMs = 1_000;

export class PickerTransactions {
  private readonly deps: PickerDeps;
  private recovery: ((text: string) => boolean) | undefined;
  private active = false;
  constructor(deps: PickerDeps) {
    this.deps = deps;
  }

  /** A failed cancellation must not release ordinary input into a remaining picker. */
  blocksInput(): boolean {
    if (this.recovery === undefined) return false;
    if (this.recovery(this.deps.terminal.snapshot().text)) return true;
    this.recovery = undefined;
    return false;
  }

  /** Background recovery for older commands cannot write into this transaction. */
  ownsInput(): boolean {
    return this.active || this.blocksInput();
  }

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
          const signal = AbortSignal.any([closed, deadline.signal]);
          const seen = { submitted: false, dialog: false };
          this.active = true;
          try {
            result = await work(this.io(signal, spec, seen));
          } catch (error) {
            // A submitted command whose dialog never rendered can still open it.
            if (!closed.aborted) await this.recover(spec, seen.submitted && !seen.dialog);
            throw error;
          } finally {
            this.active = false;
          }
        },
        { signal: deadline.signal, error: () => deadline.signal.reason },
      );
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private io(signal: AbortSignal, spec: ModelPickerSpec, seen: Progress): ModelPickerIo {
    const terminal: ScreenTerminal = {
      snapshot: () => {
        signal.throwIfAborted();
        const snapshot = this.deps.terminal.snapshot();
        seen.dialog ||= spec.isActive(snapshot.text);
        return snapshot;
      },
      sendInput: (input) => {
        signal.throwIfAborted();
        return this.deps.terminal.sendInput(input);
      },
    };
    return {
      terminal,
      signal,
      blocked: this.deps.blocked,
      submit: (command, pending) => {
        seen.submitted = true;
        return this.deps.submitDirect(command, AbortSignal.any([signal, pending]));
      },
    };
  }

  /** One bound covers a late dialog appearing, its cancellation, and its clearing. */
  private async recover(spec: ModelPickerSpec, awaitLateDialog: boolean): Promise<void> {
    const terminal = this.deps.terminal;
    const deadline = Date.now() + recoveryMs;
    try {
      if (!spec.isActive(terminal.snapshot().text)) {
        if (!awaitLateDialog) return;
        await waitForScreen(terminal, spec.isActive, recoveryMs, "late model picker");
      }
      await sendPickerInput({ terminal }, "\u001b", spec.isActive, true);
      await waitForScreen(
        terminal,
        (text) => !spec.isActive(text),
        deadline - Date.now(),
        "model picker cancellation",
      );
    } catch {
      this.recovery = spec.isActive;
    }
  }
}
