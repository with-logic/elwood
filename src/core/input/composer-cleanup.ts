/** Deferred draft cleanup owns a safe queue boundary, never human edits (PRD §5.3, C-API-56). */
import { elwoodError } from "../errors.ts";
import {
  clearStagedComposer,
  type InputTerminal,
  throwIfInputAborted,
  waitForInput,
  writeUnsafe,
} from "./abort.ts";

const owners = new WeakMap<InputTerminal, ComposerCleanup>();
type Draft = { readonly human: AbortSignal; pending: boolean };

export function stageComposer(terminal: InputTerminal): void {
  owners.get(terminal)?.stage();
}
export function submittedComposer(terminal: InputTerminal): void {
  owners.get(terminal)?.submitted();
}

/** Session cleanup is deferred beyond attachment finalizers, including clipboard restoration. */
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
  private readonly terminal: InputTerminal;
  private readonly blocked: () => boolean;
  private readonly closing: AbortSignal;
  private readonly human: () => AbortSignal;
  constructor(
    terminal: InputTerminal,
    blocked: () => boolean,
    closing: AbortSignal,
    human: () => AbortSignal,
  ) {
    this.terminal = terminal;
    this.blocked = blocked;
    this.closing = closing;
    this.human = human;
    owners.set(terminal, this);
    closing.addEventListener(
      "abort",
      () => {
        this.draft = undefined;
      },
      { once: true },
    );
  }

  stage(): void {
    this.draft ??= { human: this.human(), pending: false };
  }
  submitted(): void {
    this.draft = undefined;
  }
  defer(): void {
    if (this.owned()) this.draft!.pending = true;
  }

  /** Every queued operation, including exclusive commands, crosses this boundary first. */
  async run(work: () => Promise<void>, signal: AbortSignal): Promise<void> {
    await this.flush(signal);
    try {
      await work();
    } catch (error) {
      this.defer();
      // Never wait for a dialog in a failed operation or retain the clipboard lock for it.
      if (
        this.owned() &&
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

  private owned(): boolean {
    if (this.closing.aborted || this.draft?.human.aborted) this.draft = undefined;
    return this.draft !== undefined;
  }

  private async flush(signal: AbortSignal): Promise<void> {
    while (this.owned() && this.draft!.pending) {
      const observe = AbortSignal.any([signal, this.closing, this.draft!.human]);
      try {
        if (!(await writeUnsafe(this.terminal, { blocked: this.blocked }, observe))) {
          await this.clear();
          break;
        }
        await waitForInput(50, observe);
      } catch (error) {
        if (this.owned()) throw error;
      }
    }
    throwIfInputAborted(signal);
    throwIfInputAborted(this.closing);
  }

  private async clear(): Promise<void> {
    if (!this.owned()) return;
    const draft = this.draft;
    try {
      await this.terminal.sendInput("\u0015\u000b");
    } catch {
      throw elwoodError("wait_timeout", "Could not clear the cancelled composer draft.");
    }
    if (this.draft === draft) this.draft = undefined;
  }
}
