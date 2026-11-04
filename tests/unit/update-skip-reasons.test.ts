/** Shared skip classification accepts only declared own keys (PRD §9.2, C-LIFE-11). */
import { expect, test } from "vitest";
import { isUpdateSkipReason, updateSkipMessages } from "../../src/core/warnings/update-skips.ts";

test.each(
  Object.keys(updateSkipMessages),
)("C-LIFE-11 classifies shared skip reason %s", (reason) => {
  expect(isUpdateSkipReason(reason)).toBe(true);
});

test.each([
  undefined,
  null,
  0,
  {},
  ["active_owner"],
  "",
  "unknown",
  "toString",
  "constructor",
  "__proto__",
])("C-LIFE-11 rejects unknown or inherited skip keys (%#)", (value) => {
  expect(isUpdateSkipReason(value)).toBe(false);
});
