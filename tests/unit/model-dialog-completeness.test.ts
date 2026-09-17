/**
 * A model dialog is live only when its whole native block renders, so a quoted header
 * or a fragment cannot be driven (PRD §5.3, C-API-24).
 */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { claudeCacheWarningViewport } from "../helpers/model-dialog-viewports.ts";
import {
  claudeModelCacheConfirmationOnNo,
  claudeModelCacheConfirmationOnYes,
} from "../helpers/model-pickers.ts";

const claudeFooter = "   Enter to set as default · s to use this session only · Esc to cancel";
/** A reply quoting the warning: the dialog's own rows stay indented under its title. */
const quotedCacheWarning = [
  "⏺ It shows:",
  "  Switch model?",
  "  Your next response will be slower and use more tokens",
  "  This conversation is cached for the current model. Switching to Fable means the full history gets re-read on your next message.",
] as const;

test.each([
  [
    "a quoted header above a partial trust prompt",
    claudeModelPicker,
    "   Select model\n\nDo you trust the files in this folder?",
  ],
  [
    "a quoted header above a partial hook confirmation",
    claudeModelPicker,
    "   Select model\n\nSwitch model?\nA PreModelSwitch hook asked you to confirm",
  ],
  [
    "a reply's numbered list under a quoted header",
    claudeModelPicker,
    "   Select model\n   1. First step  do this\n   2. Second step  do that",
  ],
  [
    "a picker-shaped Codex composer row under a quoted header",
    codexModelPicker,
    "  Select Model and Effort\n› 1. gpt-5.5  described like a row",
  ],
  [
    "a numbered composer row containing the phrase",
    claudeModelPicker,
    "❯ 1. Select model  and then continue",
  ],
  [
    "a picker with rows and cursor but no footer yet",
    claudeModelPicker,
    "   Select model\n   ❯ 1. Default  Opus\n     2. Haiku  Fast",
  ],
  [
    "a quoted cache warning whose affirmative is the staged composer row",
    claudeModelPicker,
    [...quotedCacheWarning, "    No, go back", "❯ Yes, switch to Fable"].join("\n"),
  ],
  [
    "a quoted cache warning with only a staged affirmative below it",
    claudeModelPicker,
    [...quotedCacheWarning, "❯ Yes, switch to Fable"].join("\n"),
  ],
] as const)("C-API-24 %s is not a complete native dialog", (_name, spec, text) => {
  expect(spec.activeDialog(text)).toBeUndefined();
});

/**
 * The guard above keys on the composer being outdented past the dialog's own title
 * column, so the real indented captures must still read as the live follow-up.
 */
test.each([
  ["the captured 2.1.274 viewport", claudeCacheWarningViewport],
  ["the cursor-on-Yes capture", claudeModelCacheConfirmationOnYes],
  ["the cursor-on-No capture", claudeModelCacheConfirmationOnNo],
] as const)("C-API-24 %s is still a live cache warning", (_name, text) => {
  expect(claudeModelPicker.activeDialog(text)).toBe("follow-up");
});

/**
 * A complete picker that has not painted its cursor is still a LIVE dialog: it is the
 * bottom-most region and Elwood must keep holding input on it. Demanding a cursor here
 * would release queued input into an open picker mid-paint — the very hazard C-API-24
 * exists to prevent. `setPickerModel` rejects the missing cursor on its own.
 */
test("C-API-24 a complete picker that has not painted its cursor is still live", () => {
  const painting = `   Select model\n     1. Default  Opus\n     2. Haiku  Fast\n${claudeFooter}`;
  expect(claudeModelPicker.activeDialog(painting)).toBe("picker");
});
