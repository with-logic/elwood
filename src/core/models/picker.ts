/**
 * Shared /model picker automation for adapter sessions.
 * Implements PRD §5.3, §5.7, C-API-23, and C-API-24.
 */

import { delay } from "../delay.ts";
import { elwoodError } from "../errors.ts";
import { sendPickerInput } from "./input.ts";
import type {
  AgentModelOption,
  ModelDialogAuthority,
  ModelDialogStage,
  ParsedModelPicker,
} from "./rows.ts";
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
  /** A native model-dialog shell can hold input before its rows finish. */
  readonly isCandidate: (text: string) => boolean;
  /** Positive native composer evidence for releasing a foreign-dialog hold. */
  readonly isClear: (text: string) => boolean;
  readonly isOpen: (text: string) => boolean;
  /**
   * The live, bottom-most model dialog: the only one Elwood may cancel or hold input on.
   * `authority` is REQUIRED and carries proof Elwood opened this dialog (see
   * `ModelDialogAuthority`); without it every frame is `undefined`, whatever it renders.
   * The parameter is not optional so a caller cannot reach recognition without first
   * saying, in the type system, on whose authority it is reading the screen.
   */
  readonly activeDialog: (
    text: string,
    authority: ModelDialogAuthority,
  ) => ModelDialogStage | undefined;
  readonly parse: (text: string) => ParsedModelPicker;
  readonly apply: (io: ModelPickerIo, timeoutMs: number) => Promise<void>;
};

/**
 * Elwood is inside the transaction that wrote `/model`, so these reads carry its authority.
 * Every wait and write below is gated on `ours(spec)` rather than the raw `isOpen` header:
 * a header match alone is untrusted candidate evidence — a transcript or the agent's own
 * output can print `Select model` — so navigating or Escaping on it could send keys into a
 * running turn, the real composer, or another prompt (C-API-24).
 */
const opened: ModelDialogAuthority = { opened: true };

/** True only while THIS operation's own dialog is the bottom-most region of the screen. */
const ours = (spec: ModelPickerSpec) => (text: string) =>
  spec.activeDialog(text, opened) !== undefined;

/**
 * The guard for a CANCELLING Escape, which is deliberately weaker than `ours`.
 *
 * Navigation and selection must land on a fully recognized dialog, because an arrow or
 * Enter on the wrong screen changes something. Escape only closes, and this operation
 * opened the screen that is up: a picker whose rows never parsed is still OUR picker, and
 * abandoning it because the grammar cannot describe it would leave it open for the next
 * queued write. So the header is enough here, and only here.
 */
const oursOrOpen = (spec: ModelPickerSpec) => (text: string) =>
  ours(spec)(text) || spec.isOpen(text);

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
  await sendPickerInput(io, escapeKey, oursOrOpen(spec));
  await waitForScreen(
    io.terminal,
    (text) => !oursOrOpen(spec)(text),
    timeoutMs,
    `${spec.agent} model picker to close`,
    io.signal,
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
    await sendPickerInput(io, escapeKey, oursOrOpen(spec));
    const reason =
      target === -1 ? `Unknown model id "${id}".` : "Could not locate the picker cursor.";
    throw elwoodError("model_automation_failed", reason, {
      available: parsed.options.map((option) => option.id),
    });
  }
  const delta = target - parsed.cursorIndex;
  const key = delta > 0 ? arrowDown : arrowUp;
  for (let step = 0; step < Math.abs(delta); step += 1) {
    await sendPickerInput(io, key, ours(spec));
    await delay(arrowStepMs);
  }
  await waitForScreen(
    io.terminal,
    (text) => spec.parse(text).cursorIndex === target,
    timeoutMs,
    `${spec.agent} picker cursor on "${id}"`,
    io.signal,
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
    await sendPickerInput(io, escapeKey, oursOrOpen(spec));
    throw elwoodError("model_automation_failed", "Could not parse any model picker rows.");
  }
  return parsed;
}
