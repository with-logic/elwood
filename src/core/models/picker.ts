/**
 * Shared /model picker automation for adapter sessions.
 * Implements PRD §5.3, §5.7, C-API-23, and C-API-24.
 */

import { delay } from "../delay.ts";
import { elwoodError } from "../errors.ts";
import { sendPickerInput } from "./input.ts";
import type { AgentModelOption, ParsedModelPicker } from "./rows.ts";
import {
  defaultModelTimeoutMs,
  openCommandScreen,
  type ScreenTerminal,
  waitForScreen,
} from "./tui-screen.ts";

export function pickerTimeout(options?: { readonly timeoutMs?: number }): number {
  return options?.timeoutMs ?? defaultModelTimeoutMs;
}

export type ModelPickerIo = {
  readonly terminal: ScreenTerminal;
  readonly blocked?: () => boolean;
  readonly signal?: AbortSignal;
  readonly submit: (command: string, signal: AbortSignal) => Promise<void>;
};

export type ModelPickerSpec = {
  readonly agent: string;
  readonly isOpen: (text: string) => boolean;
  readonly parse: (text: string) => ParsedModelPicker;
  readonly apply: (io: ModelPickerIo, timeoutMs: number) => Promise<void>;
};

const escapeKey = "\u001b";
const arrowDown = "\u001b[B";
const arrowUp = "\u001b[A";
const arrowStepMs = 80;

export async function listPickerModels(
  io: ModelPickerIo,
  spec: ModelPickerSpec,
  timeoutMs: number,
): Promise<readonly AgentModelOption[]> {
  const parsed = await openAndParse(io, spec, timeoutMs);
  await sendPickerInput(io, escapeKey, spec.isOpen);
  await waitForScreen(
    io.terminal,
    (text) => !spec.isOpen(text),
    timeoutMs,
    `${spec.agent} model picker to close`,
  );
  return parsed.options;
}

export async function setPickerModel(
  io: ModelPickerIo,
  spec: ModelPickerSpec,
  id: string,
  timeoutMs: number,
): Promise<void> {
  const parsed = await openAndParse(io, spec, timeoutMs);
  const wanted = id.toLowerCase();
  // Row ids are already lower-cased labels (`rows.ts`), so matching the id
  // alone covers a caller that passes the display label in any case.
  const target = parsed.options.findIndex((option) => option.id === wanted);
  if (target === -1 || parsed.cursorIndex === -1) {
    await sendPickerInput(io, escapeKey, spec.isOpen);
    const reason =
      target === -1 ? `Unknown model id "${id}".` : "Could not locate the picker cursor.";
    throw elwoodError("model_automation_failed", reason, {
      available: parsed.options.map((option) => option.id),
    });
  }
  const delta = target - parsed.cursorIndex;
  const key = delta > 0 ? arrowDown : arrowUp;
  for (let step = 0; step < Math.abs(delta); step += 1) {
    await sendPickerInput(io, key, spec.isOpen);
    await delay(arrowStepMs);
  }
  await waitForScreen(
    io.terminal,
    (text) => spec.parse(text).cursorIndex === target,
    timeoutMs,
    `${spec.agent} picker cursor on "${id}"`,
  );
  await spec.apply(io, timeoutMs);
}

async function openAndParse(
  io: ModelPickerIo,
  spec: ModelPickerSpec,
  timeoutMs: number,
): Promise<ParsedModelPicker> {
  const text = await openCommandScreen({
    terminal: io.terminal,
    ...(io.signal === undefined ? {} : { signal: io.signal }),
    submit: (signal) => io.submit("/model", signal),
    isOpen: spec.isOpen,
    timeoutMs,
    label: `${spec.agent} model picker`,
  });
  const parsed = spec.parse(text);
  if (parsed.options.length === 0) {
    await sendPickerInput(io, escapeKey, spec.isOpen);
    throw elwoodError("model_automation_failed", "Could not parse any model picker rows.");
  }
  return parsed;
}
