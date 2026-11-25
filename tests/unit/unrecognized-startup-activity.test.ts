/** Unknown startup snapshots preserve the bound and Unicode text (C-ATTN-06). */
import { expect, test } from "vitest";
import { unrecognizedStartupActivity } from "../../src/core/activity/startup.ts";

test("C-ATTN-06 keeps the bounded trailing screen without splitting a surrogate pair", () => {
  const screen = `prefix😀${"a".repeat(8191)}\n\n`;
  expect(unrecognizedStartupActivity("codex", "session", screen).text).toBe("a".repeat(8191));
});

test("C-ATTN-06 retains exactly 8192 code units when the cut is a character boundary", () => {
  const tail = "x".repeat(8_192);
  expect(unrecognizedStartupActivity("codex", "session", `prefix${tail}  \n`).text).toBe(tail);
});
