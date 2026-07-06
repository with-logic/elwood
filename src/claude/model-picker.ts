/**
 * Claude /model picker automation spec.
 * Implements PRD §5.3, C-API-23, and C-API-24.
 */

import type { ModelPickerSpec } from "../core/model-picker.ts";
import { claudeModelPickerHeader, parseClaudeModelPicker } from "../core/model-rows.ts";
import { waitForScreen } from "../core/tui-screen.ts";

export const claudeModelPicker: ModelPickerSpec = {
  agent: "claude",
  isOpen: (text) => claudeModelPickerHeader.test(text),
  parse: parseClaudeModelPicker,
  // "s" applies for this session only. Enter or a number key would save the
  // selection as the user's default for new sessions, which §4.5 forbids.
  apply: async (io, timeoutMs) => {
    io.terminal.sendInput("s");
    await waitForScreen(
      io.terminal,
      (text) => !claudeModelPickerHeader.test(text),
      timeoutMs,
      "claude model picker to close after apply",
    );
  },
};
