/** Captured modern native model dialogs remain complete and navigable (C-API-23/24). */

import { expect, test } from "vitest";
import { claudeModelPicker } from "../../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../../src/codex/model-picker.ts";
import { parseCodexModelPicker } from "../../../src/core/models/rows.ts";
import { capturedFrame } from "../../helpers/captured-frames.ts";

test.each([
  ["claude-2.1.327", "collapsed", claudeModelPicker],
  ["claude-2.1.327", "more-selected", claudeModelPicker],
  ["claude-2.1.327", "expanded", claudeModelPicker],
  ["claude-2.1.327", "compact-collapsed", claudeModelPicker],
  ["claude-2.1.327", "compact-expanded", claudeModelPicker],
  ["claude-2.1.327", "compact-max", claudeModelPicker],
  ["codex-0.169.0", "top", codexModelPicker],
  ["codex-0.169.0", "middle", codexModelPicker],
  ["codex-0.169.0", "bottom", codexModelPicker],
] as const)("C-API-24 recognizes %s %s as a complete native picker", (version, name, spec) => {
  const text = capturedFrame(`${version}/model-picker/${name}`);
  expect(spec.activeDialog(text, { opened: true })).toBe("picker");
  expect(spec.isCandidate(text)).toBe(true);
  expect(spec.activeDialog(text, { opened: false })).toBeUndefined();
  expect(spec.activeDialog(`${text}\n❯ a live prompt`, { opened: true })).toBeUndefined();
});

test.each([
  ["claude-2.1.327", "collapsed", claudeModelPicker],
  ["claude-2.1.327", "more-selected", claudeModelPicker],
  ["codex-0.169.0", "middle", codexModelPicker],
] as const)("C-API-55 holds a raw-opened incomplete %s %s picker", (version, name, spec) => {
  const text = capturedFrame(`${version}/model-picker/${name}`).replace(
    /^.*(?:Esc to cancel|esc back).*$/m,
    "",
  );
  expect(spec.isCandidate(text)).toBe(true);
  expect(spec.activeDialog(text, { opened: true })).toBeUndefined();
});

test("C-API-23 Codex display spaces retain a canonical model slug", () => {
  expect(
    parseCodexModelPicker(capturedFrame("codex-0.169.0/model-picker/top")).options[2],
  ).toMatchObject({
    id: "gpt-6.1-terra",
    label: "GPT-6.1 Terra",
  });
});
