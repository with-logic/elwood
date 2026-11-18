/** Native closing hints are commands, not unpunctuated prose (C-API-24). */

import { expect, test } from "vitest";
import { claudeModelPicker } from "../../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../../src/codex/model-picker.ts";
import { capturedFrame } from "../../helpers/captured-frames.ts";
import {
  claudePicker,
  codexPickerCurrentMarkerOnly,
  codexReasoningScreen,
} from "../../helpers/model-pickers.ts";

test.each([
  [
    "modern Claude",
    claudeModelPicker,
    capturedFrame("claude-2.1.327/model-picker/collapsed"),
    "Esc to cancel",
    "I mention Esc to cancel",
  ],
  [
    "modern Codex",
    codexModelPicker,
    capturedFrame("codex-0.169.0/model-picker/top"),
    "esc back",
    "I mentioned esc back",
  ],
  ["legacy Claude", claudeModelPicker, claudePicker, "Esc to cancel", "I mention Esc to cancel"],
  [
    "legacy Codex",
    codexModelPicker,
    codexPickerCurrentMarkerOnly,
    "Press enter to confirm or esc to go back",
    "I mentioned esc to go back",
  ],
  [
    "Codex reasoning",
    codexModelPicker,
    codexReasoningScreen,
    "Press enter to confirm or esc to go back",
    "I mentioned esc to go back",
  ],
] as const)("C-API-24 %s rejects unpunctuated prose containing its closing hint", (_name, spec, text, native, prose) => {
  const quoted = text.replace(native, prose);
  expect(quoted).not.toBe(text);
  expect(spec.activeDialog(quoted, { opened: true })).toBeUndefined();
  expect(spec.isCandidate(quoted)).toBe(false);
});
