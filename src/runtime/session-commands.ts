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
import type { SessionStatusEmitter } from "./session-base-types.ts";

type Timeout = { readonly timeoutMs?: number };

export function runCompact(
  statusEvents: SessionStatusEmitter,
  submit: () => Promise<void>,
  nudge: () => void,
  options?: Timeout,
): Promise<void> {
  return sessionCompact(statusEvents, submit, nudge, options?.timeoutMs);
}

export function runListModels(
  io: ModelPickerIo,
  picker: ModelPickerSpec,
  options?: Timeout,
): Promise<readonly AgentModelOption[]> {
  return listPickerModels(io, picker, pickerTimeout(options));
}

export function runSetModel(
  io: ModelPickerIo,
  picker: ModelPickerSpec,
  id: string,
  options?: Timeout,
): Promise<void> {
  return setPickerModel(io, picker, id, pickerTimeout(options));
}

export { compactCommand };
