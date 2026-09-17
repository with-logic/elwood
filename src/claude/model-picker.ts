/**
 * Claude /model picker automation spec.
 * Implements PRD §5.3, C-API-23, and C-API-24.
 */

import { sendPickerInput } from "../core/models/input.ts";
import type { ModelPickerSpec } from "../core/models/picker.ts";
import {
  bottomDialogRow,
  claudeModelPickerHeader,
  parseClaudeModelPicker,
} from "../core/models/rows.ts";
import { waitForScreen } from "../core/models/tui-screen.ts";
import {
  isClaudeIdleComposer,
  isClaudeSwitchShell,
  parseClaudeSwitchConfirmation,
} from "./model-switch-confirmation.ts";

const enterKey = "\r";
const arrowDown = "\u001b[B";
const arrowUp = "\u001b[A";

export const claudeModelPicker: ModelPickerSpec = {
  agent: "claude",
  isOpen: (text) => claudeModelPickerHeader.test(text),
  // A PreModelSwitch hook confirmation shares the warning's shell but is the caller's.
  activeDialog: (text) => {
    const confirmation = parseClaudeSwitchConfirmation(text);
    if (confirmation !== undefined) return confirmation.isCacheWarning ? "follow-up" : undefined;
    if (isClaudeSwitchShell(text)) return "painting";
    return bottomDialogRow(text, claudeModelPickerHeader) < 0 ? undefined : "picker";
  },
  parse: parseClaudeModelPicker,
  // "s" applies for this session only. Enter or a number key would save the
  // selection as the user's default for new sessions, which §4.5 forbids.
  apply: async (io, timeoutMs) => {
    await sendPickerInput(io, "s", (text) => claudeModelPickerHeader.test(text));
    const next = await waitForScreen(
      io.terminal,
      (text) => cacheConfirmationWithCursor(text) || switchSettled(text),
      timeoutMs,
      "claude model switch confirmation or idle composer",
    );
    const confirmation = parseClaudeSwitchConfirmation(next);
    if (confirmation?.isCacheWarning === true) {
      const delta = confirmation.affirmativeIndex - confirmation.selectedIndex;
      const key = delta > 0 ? arrowDown : arrowUp;
      for (let step = 0; step < Math.abs(delta); step += 1)
        await sendPickerInput(io, key, cacheConfirmationWithCursor, true);
      await waitForScreen(
        io.terminal,
        affirmativeCacheConfirmation,
        timeoutMs,
        "active Claude cache confirmation before apply",
      );
      await sendPickerInput(io, enterKey, affirmativeCacheConfirmation, true);
    }
    await waitForScreen(
      io.terminal,
      (text) => switchSettled(text) && !claudeModelPickerHeader.test(text),
      timeoutMs,
      "claude idle composer after model switch",
    );
  },
};

/** The idle composer with no switch dialog on screen, complete or still painting. */
function switchSettled(text: string): boolean {
  return isClaudeIdleComposer(text) && !isClaudeSwitchShell(text);
}

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
