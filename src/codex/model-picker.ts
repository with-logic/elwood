/**
 * Codex /model picker automation spec.
 * Implements PRD §5.7, C-API-23, and C-API-24.
 */

import type { ModelPickerSpec } from "../core/models/picker.ts";
import { codexModelPickerHeader, parseCodexModelPicker } from "../core/models/rows.ts";
import { waitForScreen } from "../core/models/tui-screen.ts";

const reasoningHeader = /Select Reasoning Level/;
const changeConfirmed = /Model changed to/;

export const codexModelPicker: ModelPickerSpec = {
  agent: "codex",
  isOpen: (text) => codexModelPickerHeader.test(text),
  parse: parseCodexModelPicker,
  // Enter confirms the model, then Codex asks for a reasoning level with the
  // cursor pre-set on that model's default; a second Enter keeps it.
  apply: async (io, timeoutMs) => {
    await io.terminal.sendInput("\r");
    await waitForScreen(
      io.terminal,
      (text) => reasoningHeader.test(text),
      timeoutMs,
      "codex reasoning level screen",
    );
    await io.terminal.sendInput("\r");
    await waitForScreen(
      io.terminal,
      (text) => changeConfirmed.test(text) && !reasoningHeader.test(text),
      timeoutMs,
      "codex model change confirmation",
    );
  },
};
