/** Native speed badges must not block input or admit arbitrary footer text. C-SPEED-01. */
import { expect, test } from "vitest";
import { codexComposerClearance } from "../../src/codex/screen/clearance.ts";

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
