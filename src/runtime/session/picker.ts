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

/** What the operation wrote and saw, so recovery knows which dialogs can still paint. */
type Progress = { submitted: boolean; dialog: boolean; advanced: boolean; cancelled: boolean };
const recoveryMs = 1_000;
const escapeKey = "\u001b";

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
          // Picker text already on screen is a human's dialog or a stale transcript quote.
          // Elwood cannot own it, so it neither drives it nor lets recovery cancel/hold on it.
          if (spec.isActive(this.deps.terminal.snapshot().text))
            throw elwoodError(
              "model_automation_failed",
              "A model dialog was already visible before the operation began.",
            );
          const signal = AbortSignal.any([closed, deadline.signal]);
          const seen = { submitted: false, dialog: false, advanced: false, cancelled: false };
          this.active = true;
          try {
            result = await work(this.io(signal, spec, seen));
          } catch (error) {
            if (!closed.aborted) await this.recover(spec, seen, closed);
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
    const live = abortable(this.deps.terminal, signal);
    const terminal: ScreenTerminal = {
      snapshot: () => {
        const snapshot = live.snapshot();
        seen.dialog ||= spec.isActive(snapshot.text);
        return snapshot;
      },
      sendInput: (input) => {
        const sent = live.sendInput(input);
        // Escape cancels; any other key can accept a stage whose follow-up paints late.
        if (input === escapeKey) seen.cancelled = true;
        else seen.advanced = true;
        return sent;
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

  /**
   * One bound covers a late dialog appearing, its cancellation, and its clearing.
   * A submitted command or an accepted stage (Codex reasoning level, Claude cache
   * warning) can paint its dialog after the failure. Termination aborts every
   * wait and write, and an Escape the operation already wrote is never repeated.
   */
  private async recover(spec: ModelPickerSpec, seen: Progress, closed: AbortSignal): Promise<void> {
    const terminal = abortable(this.deps.terminal, closed);
    const deadline = Date.now() + recoveryMs;
    let cancelled = seen.cancelled;
    try {
      if (!spec.isActive(terminal.snapshot().text)) {
        if (!(seen.advanced || (seen.submitted && !seen.dialog))) return;
        await waitForScreen(terminal, spec.isActive, recoveryMs, "late model picker");
        cancelled = false;
      }
      if (!cancelled) await sendPickerInput({ terminal }, escapeKey, spec.isActive, true);
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
