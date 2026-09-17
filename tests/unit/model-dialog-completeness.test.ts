/**
 * A model dialog is live only when its whole native block renders, so a quoted header
 * or a fragment cannot be driven (PRD §5.3, C-API-24).
 */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import type { ModelDialogAuthority } from "../../src/core/models/rows.ts";
import {
  claudeCacheWarningViewport,
  claudePickerViewport,
  codexPickerViewport,
  codexReasoningViewport,
} from "../helpers/model-dialog-viewports.ts";
import {
  claudeModelCacheConfirmationOnNo,
  claudeModelCacheConfirmationOnYes,
} from "../helpers/model-pickers.ts";

/** Elwood opened this dialog: the authority every recognition call must carry. */
const opened: ModelDialogAuthority = { opened: true };

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
  [
    // The title itself sits at column zero here, so no indentation test can catch it.
    "an UNINDENTED quoted cache warning above a staged composer action",
    claudeModelPicker,
    [
      "⏺ It shows:",
      "Switch model?",
      "Your next response will be slower and use more tokens",
      "This conversation is cached for the current model. Switching to Fable means the full history gets re-read on your next message.",
      "  No, go back",
      "❯ Yes, switch to Fable",
    ].join("\n"),
  ],
  [
    "a COMPLETE quoted picker above a live trust prompt",
    claudeModelPicker,
    [
      "   Select model",
      "   ❯ 1. Default  Opus",
      "     2. Haiku  Fast",
      claudeFooter,
      "",
      "Do you trust the files in this folder?",
    ].join("\n"),
  ],
  [
    "a numbered composer draft that satisfies the picker grammar",
    claudeModelPicker,
    "❯ 1. Select model  draft\n  2. next  text\n  Esc to cancel",
  ],
  [
    "a second numbered list that restarts the numbering",
    claudeModelPicker,
    ["   Select model", "   ❯ 1. A  x", "     2. B  y", "     1. C  z", claudeFooter].join("\n"),
  ],
  [
    "a numbered row without the description column",
    claudeModelPicker,
    ["   Select model", "   ❯ 1. A  x", "     2. B  y", "     3. Bare", claudeFooter].join("\n"),
  ],
] as const)("C-API-24 %s is not a complete native dialog", (_name, spec, text) => {
  expect(spec.activeDialog(text, opened)).toBeUndefined();
});

/**
 * The guards above tighten the SHARED recognizer, so every real capture must still be
 * driven. A recognizer that fails closed on a live dialog would release queued input
 * into an open picker, which is the same hazard from the other side.
 */
test.each([
  ["the captured 2.1.274 cache warning", claudeModelPicker, claudeCacheWarningViewport],
  ["the cursor-on-Yes capture", claudeModelPicker, claudeModelCacheConfirmationOnYes],
  ["the cursor-on-No capture", claudeModelPicker, claudeModelCacheConfirmationOnNo],
  ["the captured 0.154.0 reasoning screen", codexModelPicker, codexReasoningViewport],
] as const)("C-API-24 %s is still a live follow-up", (_name, spec, text) => {
  expect(spec.activeDialog(text, opened)).toBe("follow-up");
});

test.each([
  ["the captured 2.1.274 picker", claudeModelPicker, claudePickerViewport],
  ["the captured 0.154.0 picker", codexModelPicker, codexPickerViewport],
] as const)("C-API-24 %s is still a live picker", (_name, spec, text) => {
  expect(spec.activeDialog(text, opened)).toBe("picker");
});

/**
 * A complete picker that has not painted its cursor is still a LIVE dialog: it is the
 * bottom-most region and Elwood must keep holding input on it. Demanding a cursor here
 * would release queued input into an open picker mid-paint — the very hazard C-API-24
 * exists to prevent. `setPickerModel` rejects the missing cursor on its own.
 */
test("C-API-24 a complete picker that has not painted its cursor is still live", () => {
  const painting = `   Select model\n     1. Default  Opus\n     2. Haiku  Fast\n${claudeFooter}`;
  expect(claudeModelPicker.activeDialog(painting, opened)).toBe("picker");
});

/**
 * The structural guarantee, and the reason this is no longer a pattern arms race.
 *
 * Every earlier round answered a specific spoof with a specific rule, and the next round
 * produced a different string for the same idea. Authority closes the CLASS instead: with
 * no transaction open, recognition returns `undefined` for ANY text — including the exact
 * frames Elwood drives when it does hold a transaction. So no rendered content, spoofed or
 * genuine, can reach cleanup outside an operation Elwood itself started.
 */
const unopened: ModelDialogAuthority = { opened: false };

test.each([
  ["the captured Claude picker", claudeModelPicker, claudePickerViewport],
  ["the captured Claude cache warning", claudeModelPicker, claudeCacheWarningViewport],
  ["the cursor-on-Yes capture", claudeModelPicker, claudeModelCacheConfirmationOnYes],
  ["the cursor-on-No capture", claudeModelPicker, claudeModelCacheConfirmationOnNo],
  ["the captured Codex picker", codexModelPicker, codexPickerViewport],
  ["the captured Codex reasoning screen", codexModelPicker, codexReasoningViewport],
] as const)("C-API-24 %s is not a live dialog when Elwood has not opened one", (_name, spec, text) => {
  expect(spec.activeDialog(text, unopened)).toBeUndefined();
});
