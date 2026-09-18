/**
 * The other side of C-API-24: every real captured dialog must still be DRIVEN when Elwood
 * holds the transaction, and none of them may be driven when it does not. A recognizer that
 * fails closed on a live dialog releases queued input into an open picker, which is the same
 * hazard from the other direction (PRD §5.3, C-API-24).
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
