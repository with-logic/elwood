/**
 * Claude /model picker automation spec.
 * Implements PRD §5.3, C-API-23, and C-API-24.
 */

import type { ModelPickerSpec } from "../core/models/picker.ts";
import { claudeModelPickerHeader, parseClaudeModelPicker } from "../core/models/rows.ts";
import { waitForScreen } from "../core/models/tui-screen.ts";
import {
  isClaudeIdleComposer,
  parseClaudeSwitchConfirmation,
} from "./model-switch-confirmation.ts";

const enterKey = "\r";
const arrowDown = "\u001b[B";
const arrowUp = "\u001b[A";

export const claudeModelPicker: ModelPickerSpec = {
  agent: "claude",
  isOpen: (text) => claudeModelPickerHeader.test(text),
  parse: parseClaudeModelPicker,
  // "s" applies for this session only. Enter or a number key would save the
  // selection as the user's default for new sessions, which §4.5 forbids.
  apply: async (io, timeoutMs) => {
    await io.terminal.sendInput("s");
    const next = await waitForScreen(
      io.terminal,
      (text) => cacheConfirmationWithCursor(text) || isClaudeIdleComposer(text),
      timeoutMs,
      "claude model switch confirmation or idle composer",
    );
    const confirmation = parseClaudeSwitchConfirmation(next);
    if (confirmation?.isCacheWarning === true) {
      const delta = confirmation.affirmativeIndex - confirmation.selectedIndex;
      const key = delta > 0 ? arrowDown : arrowUp;
      for (let step = 0; step < Math.abs(delta); step += 1) await io.terminal.sendInput(key);
      await waitForScreen(
        io.terminal,
        affirmativeCacheConfirmation,
        timeoutMs,
        "active Claude cache confirmation before apply",
      );
      await io.terminal.sendInput(enterKey);
    }
    await waitForScreen(
      io.terminal,
      (text) =>
        isClaudeIdleComposer(text) &&
        parseClaudeSwitchConfirmation(text) === undefined &&
        !claudeModelPickerHeader.test(text),
      timeoutMs,
      "claude idle composer after model switch",
    );
  },
};

function cacheConfirmationWithCursor(text: string): boolean {
  const confirmation = parseClaudeSwitchConfirmation(text);
  return confirmation?.isCacheWarning === true && confirmation.selectedIndex >= 0;
}

function affirmativeCacheConfirmation(text: string): boolean {
  const confirmation = parseClaudeSwitchConfirmation(text);
  return (
    confirmation?.isCacheWarning === true &&
    confirmation.selectedIndex === confirmation.affirmativeIndex
  );
}
