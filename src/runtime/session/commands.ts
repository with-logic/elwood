/**
 * The session's control surface, shared by every adapter session and extracted
 * from AgentSessionBase to keep it within the file-size cap. It owns `interrupt`
 * (direct Escape delivery gated on readiness state, with a timeout and
 * coalescing of concurrent interrupts, bypassing command submission) alongside
 * the `compact` and `/model` picker commands (which do go through submission).
 * Implements PRD §5.3.
 */

import { compactCommand, sessionCompact } from "../../core/compact.ts";
import type { ControlQueue } from "../../core/control-queue/index.ts";
import { holdWhileUnsafe } from "../../core/input/abort.ts";
import { ignoreInputFailure } from "../../core/input/index.ts";
import { interruptKey, sessionInterrupt } from "../../core/interrupt.ts";
import {
  listPickerModels,
  type ModelPickerSpec,
  pickerTimeout,
  setPickerModel,
} from "../../core/models/picker.ts";
import type { AgentModelOption, ModelDialogAuthority } from "../../core/models/rows.ts";
import type { ScreenTerminal } from "../../core/models/tui-screen.ts";
import type { ElwoodSessionStatus } from "../../core/types.ts";
import { PickerTransactions } from "./picker.ts";
import type { SessionStatusEmitter } from "./status-wiring.ts";

/**
 * Compact's recovery Enter asks a different question from a picker transaction's: not
 * "is this OUR dialog" but "is there ANY model dialog here that Enter would apply". It
 * has no transaction of its own, so it supplies authority to get the grammar's answer and
 * then REFUSES to write on it — the opposite of driving it. Naming it separately keeps
 * that distinction visible rather than looking like a borrowed `opened: true`.
 */
const anyDialog: ModelDialogAuthority = { opened: true };

type Timeout = { readonly timeoutMs?: number };

/**
 * The session primitives the control surface drives (interrupt readiness/status,
 * compact submission, and the model picker). The picker is a thunk because the
 * concrete adapter sets `picker` in a subclass field initializer that runs AFTER
 * the base constructor, so it is resolved per call.
 */
export type CommandSurfaceDeps = {
  readonly terminal: ScreenTerminal;
  readonly statusEvents: SessionStatusEmitter;
  readonly status: () => ElwoodSessionStatus;
  readonly everReady: () => boolean;
  readonly blocked: () => boolean;
  readonly picker: () => ModelPickerSpec;
  readonly controlQueue: ControlQueue;
  readonly submitDirect: (command: string, signal: AbortSignal) => Promise<void>;
};

/** Builds each command's interrupt/compact/picker closures from the injected primitives. */
export class CommandSurface {
  private readonly deps: CommandSurfaceDeps;
  private readonly picker: PickerTransactions;
  // Coalesces concurrent interrupts: a second call while one is in flight joins
  // the first rather than writing a second Escape, which could land on the now
  // idle composer after the first cancels the turn (a non-neutral keystroke).
  private interrupting: Promise<void> | undefined;

  constructor(deps: CommandSurfaceDeps) {
    this.deps = deps;
    this.picker = new PickerTransactions(deps);
  }

  interrupt(options?: Timeout): Promise<void> {
    if (this.interrupting) return this.interrupting;
    const sendEscape = () => Promise.resolve(this.deps.terminal.sendInput(interruptKey));
    const { statusEvents, status, everReady } = this.deps;
    const running = sessionInterrupt(
      statusEvents,
      status,
      everReady,
      sendEscape,
      options?.timeoutMs,
    );
    // Clear the in-flight guard on settle so a later interrupt can run afresh.
    this.interrupting = running.finally(() => {
      this.interrupting = undefined;
    });
    return this.interrupting;
  }

  compact(options?: Timeout): Promise<void> {
    const pending = new AbortController();
    const cancel = { signal: pending.signal, error: () => pending.signal.reason };
    const submit = () =>
      this.deps.controlQueue.send(compactCommand, "compact", undefined, { cancel });
    const { terminal, blocked } = this.deps;
    /**
     * The recovery Enter needs BOTH protections, for two different hazards.
     *
     * It runs as a queued operation (C-API-55) so it waits behind a model operation that
     * owns the queue, rather than landing in that operation's picker or being skipped for
     * good; and once it holds the slot it still decides on everything RECEIVED rather than
     * the last rendered frame (C-API-56), because a dialog can already be in the PTY buffer
     * while the observed screen is still the composer. An Enter on any model dialog — one
     * that survived cleanup, or a human's — would apply that dialog's highlighted option.
     */
    const enter = async (closed: AbortSignal) => {
      // BOTH signals: `pending` ends when compaction settles, `closed` when the queue slot
      // is revoked (session shutdown). Waiting only on `pending` would leave the hold and
      // the write running against a dying PTY after the slot was taken away.
      const live = AbortSignal.any([pending.signal, closed]);
      await holdWhileUnsafe(terminal, { blocked }, live);
      if (live.aborted) return;
      if (this.deps.picker().activeDialog(terminal.snapshot().text, anyDialog) !== undefined)
        return;
      await terminal.sendInput("\r");
    };
    const nudge = () =>
      ignoreInputFailure(this.deps.controlQueue.runExclusive("compact", enter, cancel));
    return sessionCompact(this.deps.statusEvents, submit, nudge, options?.timeoutMs).finally(() =>
      pending.abort(),
    );
  }

  listModels(options?: Timeout): Promise<readonly AgentModelOption[]> {
    const spec = this.deps.picker();
    const timeoutMs = pickerTimeout(options);
    return this.picker.run("list_models", spec, timeoutMs, (io) =>
      listPickerModels(io, spec, timeoutMs),
    );
  }

  /**
   * `around` lets an adapter wrap the picker flow in its own transaction (Codex's
   * process-wide `config.toml` lock) INSIDE the queue slot. Acquiring that lock before
   * the slot would let a following `sendMessage` dispatch first and send under the old
   * model — the slot is what preserves FIFO ordering, so it must be claimed first.
   */
  setModel(
    id: string,
    options?: Timeout,
    around?: (flow: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const spec = this.deps.picker();
    const timeoutMs = pickerTimeout(options);
    return this.picker.run("set_model", spec, timeoutMs, (io) => {
      const flow = () => setPickerModel(io, spec, id, timeoutMs);
      return around ? around(flow) : flow();
    });
  }

  blocksInput(): boolean {
    return this.picker.blocksInput();
  }

  /** A model dialog nobody here opened; a non-picker WRITE must be withheld while it is up. */
  foreignDialogVisible(): boolean {
    return this.picker.foreignDialogVisible();
  }
}
