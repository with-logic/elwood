/**
 * Shared /model picker automation for adapter sessions.
 * Implements PRD §5.3, §5.7, C-API-23, and C-API-24.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import { delay } from "../delay.ts";
import { elwoodError } from "../errors.ts";
import type { ObservedTerminal } from "../input/abort.ts";
import { arrowDown, arrowUp } from "../input/constants.ts";
import { waitUntilClosed } from "./close-wait.ts";
import { sendPickerInput } from "./input.ts";
import { isOwnCompletePicker } from "./own-picker.ts";
import type {
  AgentModelOption,
  ModelDialogAuthority,
  ModelDialogStage,
  ParsedModelPicker,
} from "./rows.ts";
import { defaultModelTimeoutMs, openCommandScreen, waitForScreen } from "./tui-screen.ts";
import { cursorOption, revealPickerRows } from "./window.ts";

export { isOwnCompletePicker } from "./own-picker.ts";

export function pickerTimeout(options?: { readonly timeoutMs?: number }): number {
  return options?.timeoutMs ?? defaultModelTimeoutMs;
}

export type ModelPickerIo = {
  /** Every key is written behind its received-output barrier (C-API-56). */
  readonly terminal: ObservedTerminal;
  readonly blocked?: () => boolean;
  readonly signal?: AbortSignal;
  readonly submit: (command: string, signal: AbortSignal) => Promise<void>;
};

export type ModelPickerSpec = {
  readonly agent: ElwoodAgentKind;
  /** A native model-dialog shell can hold input before its rows finish. */
  readonly isCandidate: (text: string) => boolean;
  /** Positive native composer evidence for releasing a foreign-dialog hold. */
  readonly isClear: (text: string) => boolean;
  /**
   * Only that the picker's title is on screen: a transcript can print it, and a picker
   * still painting shows it over stale rows. It gates the `/model` open wait and may hold
   * input; it never ends a close wait (which reads only the bottom-most region) and never
   * authorizes a write.
   */
  readonly hasPickerHeader: (text: string) => boolean;
  /**
   * Positive evidence that the bottom-most dialog is the caller's own, which replaced
   * ours: Claude's `PreModelSwitch` hook confirmation. Elwood neither answers it nor keeps
   * it as a survivor; it is left for the caller (PRD §5.3).
   */
  readonly isCallerDialog: (text: string) => boolean;
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
  /**
   * Completes listed rows from state the picker does not render, inside the operation's
   * queue slot and under its deadline/termination `signal`. Codex reads its configured
   * default here (PRD §5.3).
   */
  readonly withDefaults?: (
    options: readonly AgentModelOption[],
    signal: AbortSignal,
  ) => Promise<readonly AgentModelOption[]>;
  readonly apply: (io: ModelPickerIo, timeoutMs: number) => Promise<void>;
};

const escapeKey = "\u001b";
const arrowStepMs = 80;

/**
 * Every row the picker lists, rows outside its window included. Cancels with Escape after the
 * walk, so neither the model nor its effort changes, and returns once the picker is closed.
 */
export async function listPickerModels(
  io: ModelPickerIo,
  spec: ModelPickerSpec,
  timeoutMs: number,
): Promise<readonly AgentModelOption[]> {
  const opening = await openAndParse(io, spec, timeoutMs);
  const { options } = await revealPickerRows(io, spec, opening, { timeoutMs });
  await sendPickerInput(io, escapeKey, isOwnCompletePicker(spec));
  await waitUntilClosed(io, spec, timeoutMs);
  return options;
}

/**
 * Selects `id`, walking a scrolling window only until that row is rendered, then moving to it
 * and applying it with the adapter's own `apply`. An unknown id cancels, and the rejection
 * lists every row the walk saw.
 */
export async function setPickerModel(
  io: ModelPickerIo,
  spec: ModelPickerSpec,
  id: string,
  timeoutMs: number,
): Promise<void> {
  const opening = await openAndParse(io, spec, timeoutMs);
  const wanted = id.toLowerCase();
  // Row ids are already lower-cased labels (`rows.ts`), so matching the id
  // alone covers a caller that passes the display label in any case.
  const isTarget = (option: AgentModelOption) => option.id === wanted;
  const ownCompletePicker = isOwnCompletePicker(spec);
  // A row outside a scrolling window is as selectable as a rendered one: walk only until it
  // is rendered. An unknown id walks the whole list, so the error names every row.
  const walk = { timeoutMs, found: isTarget };
  const { frame: parsed, options } = await revealPickerRows(io, spec, opening, walk);
  const target = parsed.options.findIndex(isTarget);
  if (target === -1 || parsed.cursorOptionIndex === -1) {
    await sendPickerInput(io, escapeKey, ownCompletePicker);
    const reason =
      target === -1 ? `Unknown model id "${id}".` : "Could not locate the picker cursor.";
    throw elwoodError("model_automation_failed", reason, {
      available: options.map((option) => option.id),
    });
  }
  const delta = target - parsed.cursorOptionIndex;
  const key = delta > 0 ? arrowDown : arrowUp;
  for (let step = 0; step < Math.abs(delta); step += 1) {
    await sendPickerInput(io, key, ownCompletePicker);
    await delay(arrowStepMs);
  }
  // Settle on the cursor row's identity, not its index: a scrolled Claude window shifts
  // which rows are rendered as the cursor moves, so the target's index changes with it.
  await waitForScreen(
    io.terminal,
    (text) => cursorOption(spec.parse(text))?.id === wanted,
    timeoutMs,
    `${spec.agent} picker cursor on "${id}"`,
    io.signal,
  );
  await spec.apply(io, timeoutMs);
  await waitUntilClosed(io, spec, timeoutMs);
}

async function openAndParse(
  io: ModelPickerIo,
  spec: ModelPickerSpec,
  timeoutMs: number,
): Promise<ParsedModelPicker> {
  await openCommandScreen({
    terminal: io.terminal,
    ...(io.signal === undefined ? {} : { signal: io.signal }),
    submit: (signal) => io.submit("/model", signal),
    isOpen: spec.hasPickerHeader,
    timeoutMs,
    label: `${spec.agent} model picker`,
  });
  // The header paints before the rows finish: Claude draws the picker over its slash-command
  // menu, so a frame that merely shows `Select model` can hold three rows above stale
  // commands. Parse only the complete dialog the grammar recognizes as ours, the same guard
  // every key write passes, or a partial list is returned as the catalog. A picker that
  // never completes is not written to here: the transaction's failure cleanup Escapes it
  // once it is recognizable, and a candidate that never is keeps queued input held.
  const text = await waitForScreen(
    io.terminal,
    isOwnCompletePicker(spec),
    timeoutMs,
    `${spec.agent} model picker rows`,
    io.signal,
  );
  return spec.parse(text);
}
