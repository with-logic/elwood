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
