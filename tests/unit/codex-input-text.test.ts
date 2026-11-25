/** Assert the Rust composer whitespace boundary used in Codex comparisons (C-API-70). */
import { expect, test } from "vitest";
import { trimCodexWhitespace } from "../../src/codex/input-text.ts";

test.each([
  [" \u0085😀 \u0085 \n", "😀"],
  [" \u0085\uFEFFliteral\uFEFF \n", "\uFEFFliteral\uFEFF"],
  [" \u0085\r\n", ""],
])("C-API-70 trims native whitespace without discarding U+FEFF", (raw, expected) => {
  expect(trimCodexWhitespace(raw)).toBe(expected);
});
