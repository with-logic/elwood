/** Verify preflight against the established Claude comparison semantics (C-API-71). */
import { expect, test } from "vitest";
import { normalizeClaudePastedPayload } from "../../src/claude/input-text.ts";

test("C-API-71 Claude checks the exact canonical budget and avoids oversized expansion", () => {
  const input = "＜\\pasted_content\t\r\n\tfinal\t";
  const canonical = "<pasted_content    \n    final";
  expect(normalizeClaudePastedPayload(input)).toBe(canonical);
  expect(normalizeClaudePastedPayload(input, canonical.length)).toBe(canonical);
  expect(normalizeClaudePastedPayload(input, canonical.length - 1)).toBeUndefined();
  expect(normalizeClaudePastedPayload("large", 4)).toBeUndefined();
  expect(normalizeClaudePastedPayload(`${"\t".repeat(16_384)}x`, 65_536)).toBeUndefined();
});
