/** Malformed model metadata may hold input but never authorizes navigation (C-API-24/55). */
import { expect, onTestFinished, test, vi } from "vitest";
import { claudeModelPicker } from "../../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../../src/codex/model-picker.ts";
import { clearReadingGapMs } from "../../../src/core/models/clearance.ts";
import { parseModelViewport } from "../../../src/core/models/viewport/parse.ts";
import { PickerHold } from "../../../src/runtime/session/picker-hold.ts";
import {
  claudeClosedPickerViewport,
  codexClosedPickerViewport,
} from "../../helpers/model-dialog-viewports.ts";
import { releasesAfterClearStreak } from "../../helpers/picker-harness.ts";

test.each([
  ["claude", "↓ 0 more", claudeModelPicker, claudeClosedPickerViewport],
  ["claude", "↓ 9007199254740992 more", claudeModelPicker, claudeClosedPickerViewport],
  ["codex", "↓ 5 more", codexModelPicker, codexClosedPickerViewport],
] as const)("C-API-55 %s's incomplete %s holds until positive composer clearance", (agent, marker, spec, clear) => {
  vi.useFakeTimers({ toFake: ["performance"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const title = agent === "claude" ? "Select model" : "Select Model and Effort";
  const prefix = `${title}\n  1. One  Description\n  2. Two  Description\n${marker}`;
  expect(spec.isCandidate(prefix)).toBe(true);
  expect(parseModelViewport(prefix, agent)).toBeUndefined();
  expect(spec.activeDialog(prefix, { opened: true })).toBeUndefined();
  const hold = new PickerHold();
  expect(hold.observe(prefix, spec)).toBe(true);
  expect(spec.isCandidate(clear)).toBe(false);
  expect(spec.isClear(clear)).toBe(true);
  vi.advanceTimersByTime(clearReadingGapMs);
  expect(releasesAfterClearStreak(() => hold.observe(clear, spec))).toBe(true);
});
