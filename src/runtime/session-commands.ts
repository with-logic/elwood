/**
 * Command-surface helpers shared by every adapter session (compact + model
 * picker), extracted from AgentSessionBase to keep it within the file-size cap.
 * Implements PRD §5.3.
 */

import { compactCommand, sessionCompact } from "../core/compact.ts";
import {
  listPickerModels,
  type ModelPickerIo,
  type ModelPickerSpec,
  pickerTimeout,
  setPickerModel,
} from "../core/model-picker.ts";
import type { AgentModelOption } from "../core/model-rows.ts";
import type { ScreenTerminal } from "../core/tui-screen.ts";
import type { SessionStatusEmitter } from "./session-base-types.ts";

type Timeout = { readonly timeoutMs?: number };

/**
 * The session primitives the compact + model-picker command surface drives. The
 * picker is a thunk because the concrete adapter sets `picker` in a subclass field
 * initializer that runs AFTER the base constructor, so it is resolved per call.
 */
export type CommandSurfaceDeps = {
  readonly terminal: ScreenTerminal;
  readonly statusEvents: SessionStatusEmitter;
  readonly picker: () => ModelPickerSpec;
  readonly submit: (
    command: string,
    kind: "compact" | "list_models" | "set_model",
  ) => Promise<void>;
};

/**
 * The compact + /model picker surface, extracted from AgentSessionBase to keep it
 * within the file-size cap. Each call builds the picker IO or compact closures from
 * the injected session primitives (PRD §5.3).
 */
export class CommandSurface {
  private readonly deps: CommandSurfaceDeps;

  constructor(deps: CommandSurfaceDeps) {
    this.deps = deps;
  }

  compact(options?: Timeout): Promise<void> {
    const submit = () => this.deps.submit(compactCommand, "compact");
    const nudge = () => this.deps.terminal.sendInput("\r");
    return sessionCompact(this.deps.statusEvents, submit, nudge, options?.timeoutMs);
  }

  listModels(options?: Timeout): Promise<readonly AgentModelOption[]> {
    return listPickerModels(this.io("list_models"), this.deps.picker(), pickerTimeout(options));
  }

  setModel(id: string, options?: Timeout): Promise<void> {
    return setPickerModel(this.io("set_model"), this.deps.picker(), id, pickerTimeout(options));
  }

  private io(kind: "list_models" | "set_model"): ModelPickerIo {
    return { terminal: this.deps.terminal, submit: (c) => this.deps.submit(c, kind) };
  }
}
