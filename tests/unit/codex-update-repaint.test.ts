/**
 * Recognition of what real Codex draws after Elwood skips its 0.171+ update offer: the
 * boot composer on a start, the `Resuming session…` placeholder on a resume, and only
 * then the configured composer (PRD §5.5, C-CODEX-27).
 */
import { expect, test } from "vitest";
import { codexComposerClearance } from "../../src/codex/screen/clearance.ts";
import {
  codexDialogVisible,
  codexUnconfiguredComposerVisible,
} from "../../src/codex/update/repaint.ts";
import { codexComposer, codexSmallComposer, codexTrust } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const update = "codex-0.172.0/update";

test.each([
  `${update}/start-boot-composer`,
  `${update}/resume-placeholder`,
  "codex-0.171.0/update/resume-placeholder",
])("C-CODEX-27 %s is Codex's repaint after a skip", (capture) => {
  const frame = capturedFrame(capture);
  expect(codexUnconfiguredComposerVisible(frame)).toBe(true);
  expect(codexDialogVisible(frame)).toBe(false);
  // Configured clearance does not see it, so only the repaint shows the key was taken.
  expect(codexComposerClearance(frame)).toBe(false);
});

test.each([
  `${update}/start-boot-partial`,
  `${update}/start-notice-partial`,
  `${update}/resume-notice-partial`,
])("C-CODEX-27 the partial frame %s is neither a repaint nor a dialog", (capture) => {
  const frame = capturedFrame(capture);
  expect(codexUnconfiguredComposerVisible(frame)).toBe(false);
  expect(codexDialogVisible(frame)).toBe(false);
});

test.each([
  `${update}/start-skipped-composer`,
  `${update}/resume-skipped-composer`,
  "codex-0.171.0/update/resume-skipped-composer",
])("C-CODEX-27 the configured composer %s is left to live clearance", (capture) => {
  const frame = capturedFrame(capture);
  expect(codexUnconfiguredComposerVisible(frame)).toBe(false);
  expect(codexDialogVisible(frame)).toBe(false);
  expect(codexComposerClearance(frame)).toBe(true);
});

test.each([
  `${update}/offer-standalone-100x30`,
  `${update}/offer-standalone-60x30`,
  `${update}/offer-standalone-40x30`,
  "codex-0.171.0/update/offer-npm",
])("C-CODEX-27 the offer %s is a dialog", (capture) => {
  const frame = capturedFrame(capture);
  expect(codexDialogVisible(frame)).toBe(true);
  expect(codexUnconfiguredComposerVisible(frame)).toBe(false);
});

test.each([
  ["a trust prompt", codexTrust],
  ["a selected numbered choice", "Enable the new context cache?\n› 1. Enable now\n  2. Later"],
  ["a selection over a blank caret row", "Allow command?\n› 1. Yes\n  2. No\n›"],
])("C-CODEX-27 %s is a dialog, not Codex's repaint", (_name, frame) => {
  expect(codexDialogVisible(frame)).toBe(true);
  expect(codexUnconfiguredComposerVisible(frame)).toBe(false);
});

test.each([
  ["the configured composer", codexComposer],
  ["a resized configured composer", codexSmallComposer],
  ["an empty composer", "  >_ OpenAI Codex\n\n›\n\n  ? for shortcuts"],
  ["a typed composer", "  >_ OpenAI Codex\n\n› hello\n\n  ? for shortcuts"],
  ["a placeholder without a footer", "  >_ OpenAI Codex\n\n› Ask Codex to do anything"],
  ["no composer", "  >_ OpenAI Codex\n  Resuming session…"],
])("C-CODEX-27 %s is not Codex's repaint", (_name, frame) => {
  expect(codexUnconfiguredComposerVisible(frame)).toBe(false);
});

test("C-CODEX-27 a numbered list in an assistant reply is not a dialog", () => {
  const frame = capturedFrame(`${update}/start-boot-composer`).replace(
    "\n\n\n\n",
    "\n• Two steps:\n  1. Install\n  2. Run\n\n",
  );
  expect(codexDialogVisible(frame)).toBe(false);
  expect(codexUnconfiguredComposerVisible(frame)).toBe(true);
});
