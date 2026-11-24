/** Unknown startup snapshots preserve the bound and Unicode text (C-ATTN-06). */
import { expect, test } from "vitest";
import { unrecognizedStartupActivity } from "../../src/core/activity/startup.ts";

test("C-ATTN-06 keeps the bounded trailing screen without splitting a surrogate pair", () => {
  const screen = `prefix😀${"a".repeat(8191)}\n\n`;
  expect(unrecognizedStartupActivity("session", screen).text).toBe("a".repeat(8191));
});
