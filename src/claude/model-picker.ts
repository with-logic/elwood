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
  isClaudeSwitchConfirmation,
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
  activeDialog: (text, authority) => {
    // Nothing on screen is our dialog unless we opened one; the grammar below only has to
    // locate Elwood's own dialog, never adjudicate arbitrary agent output (C-API-24).
    if (!authority.opened) return undefined;
    // A complete confirmation is ours only when it is the cache warning; a hook's
    // confirmation wears the same shell and belongs to the caller.
    const confirmation = parseClaudeSwitchConfirmation(text);
    if (confirmation !== undefined) return confirmation.isCacheWarning ? "follow-up" : undefined;
    // The title without its options yet: hold input on it, but never write to it.
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
      io.signal,
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
        io.signal,
      );
      await sendPickerInput(io, enterKey, affirmativeCacheConfirmation, true);
    }
    await waitForScreen(
      io.terminal,
      (text) => switchSettled(text) && !claudeModelPickerHeader.test(text),
      timeoutMs,
      "claude idle composer after model switch",
      io.signal,
    );
  },
};

/**
 * The idle composer with no switch dialog on screen: complete, still painting, or a hook's.
 *
 * A `PreModelSwitch` confirmation is deliberately NOT a "shell" — it is the human's dialog,
 * so Elwood must not hold input on it or answer it. But it is equally not a settled switch:
 * the model has not changed until the human answers. Resolving here would report a change
 * that may never happen and release queued input into the open prompt, so a complete
 * confirmation of ANY kind keeps `setModel` waiting.
 */
function switchSettled(text: string): boolean {
  if (!isClaudeIdleComposer(text)) return false;
  return !(isClaudeSwitchShell(text) || isClaudeSwitchConfirmation(text));
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
