/** Raw-opened modern picker prefixes hold input until native clearance is sustained (C-API-55). */

import { expect, onTestFinished, test, vi } from "vitest";
import { claudeModelPicker } from "../../../src/claude/model-picker.ts";
import { claudeViewportGrammar } from "../../../src/claude/models/grammar.ts";
import { codexModelPicker } from "../../../src/codex/model-picker.ts";
import { codexViewportGrammar } from "../../../src/codex/models/grammar.ts";
import { clearReadingGapMs } from "../../../src/core/models/clearance.ts";
import { isModelViewportCandidate } from "../../../src/core/models/viewport/candidate.ts";
import { PickerHold } from "../../../src/runtime/session/picker-hold.ts";
import { capturedFrame } from "../../helpers/captured-frames.ts";
import {
  claudeClosedPickerViewport,
  codexClosedPickerViewport,
} from "../../helpers/model-dialog-viewports.ts";
import { releasesAfterClearStreak } from "../../helpers/picker-harness.ts";

test.each([
  ["claude-2.1.327", "collapsed", claudeModelPicker, claudeClosedPickerViewport],
  ["codex-0.169.0", "middle", codexModelPicker, codexClosedPickerViewport],
] as const)("C-API-55 %s prefixes hold and clear only after native composer readings", (version, name, spec, clear) => {
  vi.useFakeTimers({ toFake: ["performance"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const prefix = capturedFrame(`${version}/model-picker/${name}`).replace(
    /^.*(?:Esc to cancel|esc back).*$/m,
    "",
  );
  const hold = new PickerHold();
  expect(hold.observe(prefix, spec)).toBe(true);
  expect(hold.observe("a partial repaint", spec)).toBe(true);
  vi.advanceTimersByTime(clearReadingGapMs);
  expect(spec.isClear(clear)).toBe(true);
  expect(releasesAfterClearStreak(() => hold.observe(clear, spec))).toBe(true);
  const foreign = new PickerHold();
  expect(foreign.observe(`${prefix}\n❯ a human's prompt`, spec)).toBe(false);
  expect(foreign.observe(`${prefix}\n» Ask Codex to do anything`, spec)).toBe(false);
});

test.each([
  ["claude-2.1.327", "collapsed", claudeModelPicker, "▸"],
  ["claude-2.1.327", "compact-max", claudeModelPicker, "↓"],
  ["claude-2.1.327", "compact-expanded", claudeModelPicker, "↑"],
  ["codex-0.169.0", "middle", codexModelPicker, "↑"],
] as const)("C-API-55 %s holds every recognized modern painting prefix", (version, name, spec, marker) => {
  const text = capturedFrame(`${version}/model-picker/${name}`);
  const start = text.indexOf(marker) + marker.length;
  for (let end = start; end <= text.length; end += 1) {
    const prefix = text.slice(0, end);
    expect(spec.isCandidate(prefix), JSON.stringify(prefix)).toBe(true);
    if (
      end < text.indexOf("Esc to cancel") + "Esc to cancel".length &&
      version.startsWith("claude")
    )
      expect(spec.activeDialog(prefix, { opened: true })).toBeUndefined();
  }
});

test.each([
  [
    "unsafe partial ordinal",
    "Select Model and Effort\n↑\n  2. Model  Description\n› 9007199254740992",
    codexModelPicker,
  ],
  [
    "zero partial ordinal",
    "Select Model and Effort\n↑\n  2. Model  Description\n› 0",
    codexModelPicker,
  ],
  [
    "nonconsecutive partial ordinal",
    "Select Model and Effort\n↑\n  2. Model  Description\n› 4",
    codexModelPicker,
  ],
  [
    "partial content followed by a prompt",
    "Select Model and Effort\n↑\n  2. Model  Description\n› 3. Nex\n❯ user input",
    codexModelPicker,
  ],
  [
    "partial up marker after models",
    "Select model\n  1. Model  Description\n↑ 2 mo",
    claudeModelPicker,
  ],
  ["duplicate partial up marker", "Select model\n↑ 2 more\n↑ 3 mo", claudeModelPicker],
  ["partial down marker before models", "Select model\n↓ 3 mo", claudeModelPicker],
  [
    "unknown control after modern items",
    "Select model\n  1. One  Description\n  2. Two  Description\n▸ More models\n\nAn unknown control",
    claudeModelPicker,
  ],
] as const)("C-API-55 %s is not a native picker prefix", (_name, text, spec) => {
  expect(
    isModelViewportCandidate(
      text,
      spec === claudeModelPicker ? claudeViewportGrammar : codexViewportGrammar,
    ),
  ).toBe(false);
  expect(spec.activeDialog(text, { opened: true })).toBeUndefined();
});

test("C-API-24 an Ultra composer carrying a model title is never a modal cursor", () => {
  const text = capturedFrame("codex-0.169.0/model-picker/top");
  const staged = text.replace("Select Model and Effort", "» Select Model and Effort");
  expect(codexModelPicker.activeDialog(staged, { opened: true })).toBeUndefined();
  expect(codexModelPicker.isCandidate(staged)).toBe(false);
  const beforeRows = text.replace(
    "Select Model and Effort",
    "Select Model and Effort\n» Ask Codex",
  );
  expect(codexModelPicker.activeDialog(beforeRows, { opened: true })).toBeUndefined();
  expect(codexModelPicker.isCandidate(beforeRows)).toBe(false);
});
