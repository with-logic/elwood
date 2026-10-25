/** Exclusive model-picker queue ownership and failure cleanup (PRD §5.3, C-API-55). */
import type { ControlQueue } from "../../core/control-queue/index.ts";
import { elwoodError } from "../../core/errors.ts";
import { behindReceivedOutputBarrier, type ObservedTerminal } from "../../core/input/abort.ts";
import type { ModelPickerIo, ModelPickerSpec } from "../../core/models/picker.ts";
import { abortable, cleanUpDialog, escapeKey, ours, type Progress } from "./picker-cleanup.ts";
import { PickerHold } from "./picker-hold.ts";

type PickerDeps = {
  readonly controlQueue: ControlQueue;
  readonly observeRendered?: (listener: (read?: () => string) => void) => void;
  readonly inputSignal?: () => AbortSignal;
  readonly submitDirect: (command: string, signal: AbortSignal) => Promise<void>;
  /** Carries the received-output barrier every picker key is written behind (C-API-56). */
  readonly terminal: ObservedTerminal;
  readonly blocked: () => boolean;
  /** The adapter's picker spec, for recognizing a dialog nobody here opened. */
  readonly picker: () => ModelPickerSpec;
};

export class PickerTransactions {
  private readonly deps: PickerDeps;
  private readonly foreign = new PickerHold();
  private active: { signal: AbortSignal; progress: Progress } | undefined;
  private survivor: ModelPickerSpec | undefined;
  /** Forgets the survivor only after the composer is positively, sustainedly clear. */
  private readonly survivorHold = new PickerHold();
  constructor(deps: PickerDeps) {
    this.deps = deps;
    deps.observeRendered?.((read) => this.foreignDialogVisible(read));
  }

  /**
   * Whether a model dialog is on screen that queued input must not be written into.
   *
   * TWO cases, and the difference matters. A SURVIVOR is a dialog our own cleanup could not
   * cancel, or what its cleanup left on a frame that is not positively clear (a blank or
   * half-painted repaint): it is ours, and it is remembered until the composer is clear. A
   * dialog nobody here opened — a human who typed `/model` themselves — is NOT ours and
   * never becomes a survivor, but Enter on it still applies its highlighted row, and Escape
   * still discards the human's state. So writes are held on any visible model dialog,
   * whoever opened it; ownership decides what Elwood may DRIVE, not what it may safely type
   * over (C-API-55).
   */
  blocksInput(): boolean {
    if (this.survivor === undefined) return false;
    const text = this.deps.terminal.snapshot().text;
    if (this.survivor.activeDialog(text, ours) !== undefined) {
      this.survivorHold.hold();
      return true;
    }
    // The caller's own dialog replaced ours, so nothing of ours is left to hold on: a
    // `PreModelSwitch` hook confirmation, whether cleanup ended on it or on its painting shell.
    if (this.survivor.isCallerDialog(text)) {
      this.survivor = undefined;
      return false;
    }
    // An UNRECOGNIZED frame is not proof the survivor is gone: a picker repainting between
    // stages, or half-painted, matches neither grammar, and forgetting it there would release
    // queued input into the frame that follows. Only sustained positive clearance does.
    if (this.survivorHold.observe(text, this.survivor)) return true;
    this.survivor = undefined;
    return false;
  }

  /**
   * Whether a model dialog nobody here opened is on screen — a human who typed `/model`
   * themselves. It is NOT ours, so it never becomes a `survivor` and must not suppress
   * readiness (that would deadlock our own picker, whose dialog is visible by design).
   * But Enter on it still applies its highlighted row and Escape still discards the
   * human's state, so a WRITE that is not part of a picker transaction — `/login`
   * recovery, a queued paste — must be withheld while it is up (C-API-55).
   */
  foreignDialogVisible(read?: () => string): boolean {
    if (this.survivor !== undefined) return false;
    if (this.active?.progress.commandSubmitted && !this.active.signal.aborted) return false;
    return this.foreign.observe(read?.() ?? this.deps.terminal.snapshot().text, this.deps.picker());
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
    work: (io: ModelPickerIo, signal: AbortSignal) => Promise<T>,
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
          // human's dialog, or a transcript quote the unanchored `hasPickerHeader` would drive.
          const human = this.deps.inputSignal?.();
          const before = this.deps.terminal.snapshot().text;
          // We have NOT written `/model` yet, so nothing here is ours. We still ask the
          // grammar under a hypothetical authority: anything it would call a dialog is
          // someone else's, which is precisely why the operation must refuse to start.
          if (spec.hasPickerHeader(before) || spec.activeDialog(before, ours) !== undefined)
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
          const ownership = AbortSignal.any(human === undefined ? [closed] : [closed, human]);
          const signal = AbortSignal.any([ownership, deadline.signal]);
          this.active = { signal: ownership, progress };
          const revoked = () => this.foreign.observe(this.deps.terminal.snapshot().text, spec);
          human?.addEventListener("abort", revoked, { once: true });
          try {
            result = await work(this.io(signal, spec, progress), signal);
          } catch (error) {
            if (!ownership.aborted && progress.commandSubmitted)
              await this.cleanUp(spec, progress, ownership);
            throw error;
          } finally {
            human?.removeEventListener("abort", revoked);
            this.active = undefined;
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
    // Every key is decided on everything received, like cleanup's Escape (C-API-56).
    const terminal = behindReceivedOutputBarrier(this.deps.terminal, {
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
    });
    return {
      terminal,
      signal,
      blocked: this.deps.blocked,
      // The slot already owns the queue, so the command is written directly.
      submit: async (command, pending) => {
        signal.throwIfAborted();
        await this.deps.submitDirect(command, AbortSignal.any([signal, pending]));
        progress.commandSubmitted = true;
      },
    };
  }

  private async cleanUp(
    spec: ModelPickerSpec,
    progress: Progress,
    closed: AbortSignal,
  ): Promise<void> {
    const noneRecognized = await cleanUpDialog(this.deps.terminal, spec, progress, closed);
    // Nothing of OURS being recognizable is not proof our dialog is gone: a blank or
    // half-painted repaint matches neither grammar, and the picker can paint again after it.
    // So once our dialog was seen, or while a picker header is up, anything short of a
    // positively clear composer is kept as a survivor, held and never written to. A frame
    // that shows neither is not ours, and a terminated session holds nothing. A dialog the
    // caller owns that replaced ours is left for the caller: `blocksInput` forgets the
    // survivor on it.
    const text = this.deps.terminal.snapshot().text;
    const mayBeOurs = progress.dialogSeen || spec.hasPickerHeader(text);
    if (noneRecognized && (closed.aborted || spec.isClear(text) || !mayBeOurs)) return;
    this.survivor = spec;
    this.survivorHold.hold();
  }
}
