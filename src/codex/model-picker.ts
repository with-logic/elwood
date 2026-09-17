/**
 * Codex /model picker automation spec.
 * Implements PRD §5.7, C-API-23, and C-API-24.
 */

import { sendPickerInput } from "../core/models/input.ts";
import type { ModelPickerSpec } from "../core/models/picker.ts";
import {
  bottomDialogRow,
  codexModelPickerHeader,
  parseCodexModelPicker,
} from "../core/models/rows.ts";
import { waitForScreen } from "../core/models/tui-screen.ts";

const reasoningHeader = /Select Reasoning Level/;
const changeConfirmed = /Model changed to/;

export const codexModelPicker: ModelPickerSpec = {
  agent: "codex",
  isOpen: (text) => codexModelPickerHeader.test(text),
  activeDialog: (text) => {
    const picker = bottomDialogRow(text, codexModelPickerHeader);
    const level = bottomDialogRow(text, reasoningHeader);
    if (picker < 0 && level < 0) return undefined;
    return level > picker ? "follow-up" : "picker";
  },
  parse: parseCodexModelPicker,
  // Enter confirms the model, then Codex asks for a reasoning level with the
  // cursor pre-set on that model's default; a second Enter keeps it.
  apply: async (io, timeoutMs) => {
    await sendPickerInput(io, "\r", (text) => codexModelPickerHeader.test(text));
    await waitForScreen(
      io.terminal,
      (text) => reasoningHeader.test(text),
      timeoutMs,
      "codex reasoning level screen",
    );
    await sendPickerInput(io, "\r", (text) => reasoningHeader.test(text));
    await waitForScreen(
      io.terminal,
      (text) => changeConfirmed.test(text) && !reasoningHeader.test(text),
      timeoutMs,
      "codex model change confirmation",
    );
  },
};
