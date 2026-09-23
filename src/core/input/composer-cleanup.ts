/** Deferred draft cleanup owns a safe queue boundary, never caller-owned edits (PRD §5.3, C-API-56). */
import { elwoodError } from "../errors.ts";
import {
  clearStagedComposer,
  type InputTerminal,
  throwIfInputAborted,
  waitForInput,
  writeUnsafe,
} from "./abort.ts";

import { clearAndObserveComposer, type EmptyComposerObserver } from "./clear-ack.ts";
import { unsafeWriteRetryMs } from "./constants.ts";

const owners = new WeakMap<InputTerminal, ComposerCleanup>();
type Draft = { readonly rawInputSignal: AbortSignal; pending: boolean };

/** Register ComposerCleanup before staging; unregistered terminals deliberately record no ownership. */
export function stageComposer(terminal: InputTerminal): AbortSignal | undefined {
  return owners.get(terminal)?.stage();
}
/** Mark submission after staging; this is also a no-op without prior registration. */
export function submittedComposer(terminal: InputTerminal): void {
  owners.get(terminal)?.submitted();
}

/**
 * Registered session cleanup is deferred beyond attachment finalizers, including
 * clipboard restoration. Unregistered direct callers instead attempt an immediate,
 * observed, unblocked best-effort clear; they have no retained ownership token.
 */
export async function requestComposerCleanup(
  terminal: InputTerminal,
  blocked?: () => boolean,
): Promise<void> {
  const owner = owners.get(terminal);
  if (owner) owner.defer();
  else if (!(await writeUnsafe(terminal, { blocked: () => blocked?.() === true })))
    await clearStagedComposer(terminal);
}

export class ComposerCleanup {
  private draft: Draft | undefined;
  private baseline: AbortSignal;
  private stagedGeneration: AbortSignal | undefined;
  private readonly terminal: InputTerminal;
  private readonly blocked: () => boolean;
  private readonly closing: AbortSignal;
  private readonly rawInputSignal: () => AbortSignal;
  private readonly observeEmpty: EmptyComposerObserver;
  /** Register this owner before any stage/submit hooks or queued operation. */
  constructor(
    terminal: InputTerminal,
    blocked: () => boolean,
    closing: AbortSignal,
    rawInputSignal: () => AbortSignal,
    observeEmpty: EmptyComposerObserver,
  ) {
    this.terminal = terminal;
    this.blocked = blocked;
    this.closing = closing;
    this.rawInputSignal = rawInputSignal;
    this.observeEmpty = observeEmpty;
    this.baseline = rawInputSignal();
    owners.set(terminal, this);
    closing.addEventListener(
      "abort",
      () => {
        this.draft = undefined;
      },
      { once: true },
    );
  }

  stage(): AbortSignal {
    this.stagedGeneration = this.rawInputSignal();
    if (this.stagedGeneration === this.baseline)
      this.draft ??= { rawInputSignal: this.stagedGeneration, pending: false };
    return this.stagedGeneration;
  }
  submitted(): void {
    // Only an uninterrupted submission establishes a fresh composer after raw edits.
    if (this.stagedGeneration === this.rawInputSignal()) this.baseline = this.stagedGeneration;
    this.stagedGeneration = undefined;
    this.draft = undefined;
  }
  defer(): void {
    if (this.reconcileDraftOwnership()) this.draft!.pending = true;
  }

  /** Preparation may cancel before work; once invoked exactly once, work owns its task lifetime. */
  async run(work: () => Promise<void>, preparationSignal: AbortSignal): Promise<void> {
    await this.flush(preparationSignal);
    throwIfInputAborted(preparationSignal);
    try {
      await work();
    } catch (error) {
      this.defer();
      // Never wait for a dialog in a failed operation or retain the clipboard lock for it.
      if (
        this.reconcileDraftOwnership() &&
        !(await writeUnsafe(this.terminal, { blocked: this.blocked }, this.closing))
      ) {
        try {
          await this.clear();
        } catch {
          /* The next operation must retry or reject. */
        }
      }
      throw error;
    }
  }

  private reconcileDraftOwnership(): boolean {
    if (this.closing.aborted || this.draft?.rawInputSignal.aborted) this.draft = undefined;
    return this.draft !== undefined;
  }

  private async flush(signal: AbortSignal): Promise<void> {
    while (this.reconcileDraftOwnership() && this.draft!.pending) {
      const observe = AbortSignal.any([signal, this.closing, this.draft!.rawInputSignal]);
      try {
        if (!(await writeUnsafe(this.terminal, { blocked: this.blocked }, observe))) {
          await this.clear(observe);
          break;
        }
        await waitForInput(unsafeWriteRetryMs, observe);
      } catch (error) {
        if (this.reconcileDraftOwnership()) throw error;
      }
    }
    throwIfInputAborted(signal);
    throwIfInputAborted(this.closing);
  }

  private async clear(preparationSignal = this.closing): Promise<void> {
    if (!this.reconcileDraftOwnership()) return;
    const draft = this.draft!;
    const signal = AbortSignal.any([preparationSignal, this.closing, draft.rawInputSignal]);
    try {
      await clearAndObserveComposer(this.terminal, this.blocked, this.observeEmpty, signal);
    } catch {
      throwIfInputAborted(signal);
      throw elwoodError("wait_timeout", "Could not clear the staged composer draft.");
    }
    if (this.draft === draft) this.draft = undefined;
  }
}
