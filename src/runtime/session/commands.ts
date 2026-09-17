/**
 * The session's control surface, shared by every adapter session and extracted
 * from AgentSessionBase to keep it within the file-size cap. It owns `interrupt`
 * (direct Escape delivery gated on readiness state, with a timeout and
 * coalescing of concurrent interrupts, bypassing command submission) alongside
 * the `compact` and `/model` picker commands (which do go through submission).
 * Implements PRD §5.3.
 */

import { compactCommand, sessionCompact } from "../../core/compact.ts";
import { writeUnsafe } from "../../core/input/abort.ts";
import { ignoreInputFailure } from "../../core/input/index.ts";
import { interruptKey, sessionInterrupt } from "../../core/interrupt.ts";
import {
  listPickerModels,
  type ModelPickerIo,
  type ModelPickerSpec,
  pickerTimeout,
  setPickerModel,
} from "../../core/models/picker.ts";
import type { AgentModelOption } from "../../core/models/rows.ts";
import type { ScreenTerminal } from "../../core/models/tui-screen.ts";
import type { ElwoodSessionStatus } from "../../core/types.ts";
import type { SessionStatusEmitter } from "./status-wiring.ts";

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
  readonly submit: (
    command: string,
    kind: "compact" | "list_models" | "set_model",
    signal: AbortSignal,
    onDispatch?: (operation: AbortSignal) => void,
  ) => Promise<void>;
};

/** Builds each command's interrupt/compact/picker closures from the injected primitives. */
export class CommandSurface {
  private readonly deps: CommandSurfaceDeps;
  // Coalesces concurrent interrupts: a second call while one is in flight joins
  // the first rather than writing a second Escape, which could land on the now
  // idle composer after the first cancels the turn (a non-neutral keystroke).
  private interrupting: Promise<void> | undefined;

  constructor(deps: CommandSurfaceDeps) {
    this.deps = deps;
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
    // The queue aborts an operation's signal when the NEXT one dispatches: from then on
    // the composer belongs to that operation, and a recovery Enter would land in it.
    const submit = () =>
      this.deps.submit(compactCommand, "compact", pending.signal, (operation) =>
        operation.addEventListener("abort", () => pending.abort(), { once: true }),
      );
    // The recovery Enter decides on everything received, not the last frame (C-API-56).
    const { terminal, blocked } = this.deps;
    const nudge = () =>
      ignoreInputFailure(
        writeUnsafe(terminal, { blocked }, pending.signal).then((unsafe) =>
          unsafe ? undefined : terminal.sendInput("\r"),
        ),
      );
    return sessionCompact(this.deps.statusEvents, submit, nudge, options?.timeoutMs).finally(() =>
      pending.abort(),
    );
  }

  listModels(options?: Timeout): Promise<readonly AgentModelOption[]> {
    return listPickerModels(this.io("list_models"), this.deps.picker(), pickerTimeout(options));
  }

  setModel(id: string, options?: Timeout): Promise<void> {
    return setPickerModel(this.io("set_model"), this.deps.picker(), id, pickerTimeout(options));
  }

  private io(kind: "list_models" | "set_model"): ModelPickerIo {
    return {
      terminal: this.deps.terminal,
      blocked: this.deps.blocked,
      submit: (c, signal) => this.deps.submit(c, kind, signal),
    };
  }
}
