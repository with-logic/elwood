/** Native speed badges must not block input or admit arbitrary footer text. C-SPEED-01. */
import { expect, test } from "vitest";
import {
  codexComposerClearance,
  codexComposerConfigured,
} from "../../src/codex/screen/clearance.ts";

test.each([
  "",
  " Fast",
  " Ultrafast",
])("C-SPEED-01 Codex recognizes the %s speed badge", (badge) => {
  expect(
    codexComposerClearance(
      `› Ask Codex to do anything\n  GPT-6-Astra medium${badge} · /tmp/project\n  ? for shortcuts`,
    ),
  ).toBe(true);
});

test.each([
  "  xhigh fast · /tmp/project",
  "  GPT-6-Astra xhigh fast · /tmp/project",
  "  xhigh · /tmp/project",
  "  ultra ultrafast · ~/project",
  "  medium · C:\\project",
])("C-API-28 C-SPEED-01 recognizes configured native footer %s", (footer) => {
  const frame = `› Ask Codex to do anything\n${footer}\n  ? for shortcuts`;
  expect(codexComposerConfigured(frame)).toBe(true);
  expect(codexComposerClearance(frame)).toBe(true);
});

test.each([
  "  xhigh fast",
  "  xhigh fast · relative/project",
  "  xhigh Faster · /tmp/project",
  "  unknown fast · /tmp/project",
  "  xhigh fast · /tmp/project\n  Press Enter to continue",
])("C-API-28 C-SPEED-01 unknown footer %s still holds input", (footer) => {
  const frame = `› Ask Codex to do anything\n${footer}`;
  expect(codexComposerConfigured(frame)).toBe(false);
  expect(codexComposerClearance(frame)).toBe(false);
});

test.each([
  " Faster",
  " Ultra Fast",
  " Unknown",
])("C-SPEED-01 unrecognized %s badge remains blocked", (badge) => {
  expect(
    codexComposerClearance(
      `› Ask Codex to do anything\n  GPT-6-Astra medium${badge} · /tmp/project\n  ? for shortcuts`,
    ),
  ).toBe(false);
});
