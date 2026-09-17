/** Only a bottom-most native model dialog is a live one (PRD §5.3, C-API-23/24). */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import {
  claudeCacheWarningViewport,
  claudeClosedPickerViewport,
  claudePickerViewport,
  codexClosedPickerViewport,
  codexPickerViewport,
  codexReasoningViewport,
} from "../helpers/model-dialog-viewports.ts";
import {
  claudeModelCacheConfirmationOnNo,
  claudeModelCacheConfirmationOnYes,
  claudePicker,
  claudePickerCursorOnHaiku,
  codexPickerCurrentIsDefault,
  codexPickerSplitMarkers,
  codexReasoningScreen,
} from "../helpers/model-pickers.ts";

/** A running turn: the agent's reply quotes a dialog above the live working row and composer. */
const quotedInReply = (bullet: string, quoted: string, caret: string) =>
  [
    `${bullet} The dialog looks like this:`,
    quoted,
    "",
    "  Working (esc to interrupt)",
    "",
    caret,
  ].join("\n");

test.each([
  ["Claude picker", claudeModelPicker, quotedInReply("⏺", claudePicker, "❯ ")],
  [
    "Claude picker (older bullet)",
    claudeModelPicker,
    quotedInReply("●", claudePickerViewport, "❯"),
  ],
  ["Claude cache warning", claudeModelPicker, quotedInReply("⏺", claudeCacheWarningViewport, "❯ ")],
  ["Codex picker", codexModelPicker, quotedInReply("•", codexPickerViewport, "› Ask Codex")],
  ["Codex reasoning level", codexModelPicker, quotedInReply("•", codexReasoningScreen, "› ")],
] as const)("C-API-24 a %s quoted in a running turn's reply is not a live dialog", (_name, spec, forged) => {
  expect(spec.activeDialog(forged)).toBeUndefined();
});

test.each([
  ["Claude picker", claudeModelPicker, claudePicker, "picker"],
  ["Claude picker, cursor moved", claudeModelPicker, claudePickerCursorOnHaiku, "picker"],
  ["Claude 2.1.274 picker viewport", claudeModelPicker, claudePickerViewport, "picker"],
  ["Claude cache warning on No", claudeModelPicker, claudeModelCacheConfirmationOnNo, "follow-up"],
  [
    "Claude cache warning on Yes",
    claudeModelPicker,
    claudeModelCacheConfirmationOnYes,
    "follow-up",
  ],
  [
    "Claude 2.1.274 cache warning viewport",
    claudeModelPicker,
    claudeCacheWarningViewport,
    "follow-up",
  ],
  ["Claude closed picker viewport", claudeModelPicker, claudeClosedPickerViewport, undefined],
  ["Codex picker", codexModelPicker, codexPickerCurrentIsDefault, "picker"],
  ["Codex picker below a transcript row", codexModelPicker, codexPickerSplitMarkers, "picker"],
  ["Codex 0.154.0 picker viewport", codexModelPicker, codexPickerViewport, "picker"],
  ["Codex reasoning level", codexModelPicker, codexReasoningScreen, "follow-up"],
  ["Codex 0.154.0 reasoning viewport", codexModelPicker, codexReasoningViewport, "follow-up"],
  [
    "Codex picker reopened below its reasoning level",
    codexModelPicker,
    `${codexReasoningScreen}\n${codexPickerCurrentIsDefault}`,
    "picker",
  ],
  ["Codex closed picker viewport", codexModelPicker, codexClosedPickerViewport, undefined],
] as const)("C-API-24 the captured %s is recognized as its live stage", (_name, spec, captured, stage) => {
  expect(spec.activeDialog(captured)).toBe(stage);
});

/** Rows both CLIs render as live bottom-most content that is not a model dialog. */
const permissionDialog = [
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for this command",
  "  3. No, and tell Claude what to do differently (esc)",
  "",
  "Esc to cancel",
].join("\n");

test.each([
  [
    "Claude composer holding the phrase",
    claudeModelPicker,
    "⏺ Done.\n\n────\n❯ Select model\n────",
  ],
  ["Claude reply starting with the phrase", claudeModelPicker, "⏺ Select model"],
  ["Codex composer holding the phrase", codexModelPicker, "• Done.\n\n› Select Model and Effort"],
  ["Codex composer holding the level phrase", codexModelPicker, "› Select Reasoning Level for x"],
] as const)("C-API-24 a %s on its own row is not a dialog header", (_name, spec, text) => {
  expect(spec.activeDialog(text)).toBeUndefined();
});

test.each([
  [
    "a permission dialog",
    claudeModelPicker,
    `⏺ It shows:\n${claudePickerViewport}\n\n${permissionDialog}`,
  ],
  [
    "a numbered composer row",
    claudeModelPicker,
    `⏺ It shows:\n${claudePicker}\n\n❯ 1. do the first thing`,
  ],
  [
    "a Codex approval dialog",
    codexModelPicker,
    `• It shows:\n${codexReasoningViewport}\n\nAllow command?\n› 1. Yes, proceed (y)\n  2. No (esc)`,
  ],
] as const)("C-API-24 a quoted dialog above %s is not the live dialog", (_name, spec, text) => {
  expect(spec.activeDialog(text)).toBeUndefined();
});

test.each([
  [
    "double-spaced staged Claude composer text",
    claudeModelPicker,
    `⏺ It shows:\n${claudePickerViewport}\n\n────\n❯ 1. fix the bug  then run the tests\n────`,
  ],
  [
    "double-spaced staged Codex composer text",
    codexModelPicker,
    `• It shows:\n${codexPickerViewport}\n\n› 1. fix the bug  then run the tests`,
  ],
  [
    "a composer row continuing the quoted numbering",
    codexModelPicker,
    `• It shows:\n${codexPickerCurrentIsDefault}\n\n› 5. another model  described like a row`,
  ],
  [
    "an approval prompt whose options carry no caret",
    claudeModelPicker,
    `⏺ It shows:\n${claudePicker}\n\nDo you want to proceed?\n  1. Yes\n  2. No`,
  ],
  [
    "an approval prompt with described options",
    codexModelPicker,
    `• It shows:\n${codexReasoningScreen}\n\nAllow command?\n  1. Yes  (recommended)\n  2. No  (esc)`,
  ],
] as const)("C-API-24 a quoted dialog above %s is not the live dialog", (_name, spec, text) => {
  expect(spec.activeDialog(text)).toBeUndefined();
});

test("C-API-24 a region with two cursor rows is not one native picker", () => {
  const twoCursors = claudePicker.replace("     4. Sonnet ", "   ❯ 4. Sonnet ");
  expect(claudeModelPicker.activeDialog(claudePicker)).toBe("picker");
  expect(claudeModelPicker.activeDialog(twoCursors)).toBeUndefined();
});
