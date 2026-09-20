/**
 * Codex /model picker automation spec.
 * Implements PRD §5.7, C-API-23, and C-API-24.
 */

import { sendPickerInput } from "../core/models/input.ts";
import type { ModelPickerSpec } from "../core/models/picker.ts";
import {
  bottomDialogCandidate,
  bottomDialogRow,
  codexModelPickerHeader,
  ownOperation,
  parseCodexModelPicker,
} from "../core/models/rows.ts";
import { waitForScreen } from "../core/models/tui-screen.ts";

import { codexComposerClearance } from "./screen/clearance.ts";

const reasoningHeader = /Select Reasoning Level/;
const changeConfirmed = /Model changed to/;

export const codexModelPicker: ModelPickerSpec = {
  agent: "codex",
  isClear: codexComposerClearance,
  isCandidate: (text) =>
    bottomDialogCandidate(text, codexModelPickerHeader) ||
    bottomDialogCandidate(text, reasoningHeader),
  isOpen: (text) => codexModelPickerHeader.test(text),
  activeDialog: (text, authority) => {
    // Nothing on screen is our dialog unless we opened one; the grammar below only has to
    // locate Elwood's own dialog, never adjudicate arbitrary agent output (C-API-24).
    if (!authority.opened) return undefined;
    const picker = bottomDialogRow(text, codexModelPickerHeader);
    const level = bottomDialogRow(text, reasoningHeader);
    if (picker < 0 && level < 0) return undefined;
    return level > picker ? "follow-up" : "picker";
  },
  parse: parseCodexModelPicker,
  // Enter confirms the model, then Codex asks for a reasoning level with the
  // cursor pre-set on that model's default; a second Enter keeps it.
  apply: async (io, timeoutMs) => {
    // Enter CONFIRMS a model, so it is revalidated against the operation's own picker
    // rather than a bare header a transcript could print (C-API-24).
    await sendPickerInput(
      io,
      "\r",
      (text) => codexModelPicker.activeDialog(text, ownOperation) === "picker",
    );
    await waitForScreen(
      io.terminal,
      (text) => reasoningHeader.test(text),
      timeoutMs,
      "codex reasoning level screen",
      io.signal,
    );
    // Same for the reasoning stage: only our own follow-up may receive this Enter.
    await sendPickerInput(
      io,
      "\r",
      (text) => codexModelPicker.activeDialog(text, ownOperation) === "follow-up",
    );
    await waitForScreen(
      io.terminal,
      (text) => changeConfirmed.test(text) && !reasoningHeader.test(text),
      timeoutMs,
      "codex model change confirmation",
      io.signal,
    );
  },
};
