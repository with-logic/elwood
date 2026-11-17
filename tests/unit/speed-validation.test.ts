/** Invalid-speed diagnostics cannot change accepted native tiers. C-SPEED-01. */
import { expect, test } from "vitest";
import { ElwoodError } from "../../src/core/errors.ts";
import { codexServiceTier } from "../../src/core/speed/types.ts";
import { validateSpeed } from "../../src/core/speed/validate.ts";

test("C-SPEED-01 mutating error details cannot change accepted Codex tiers", () => {
  let values: unknown;
  try {
    validateSpeed("codex", "bogus");
  } catch (error) {
    if (!(error instanceof ElwoodError)) throw error;
    values = error.details["valid"];
  }
  if (!Array.isArray(values)) throw new Error("Expected invalid-speed tier details");
  const original = [...values];
  try {
    values.push("bogus");
    expect(() => validateSpeed("codex", "bogus")).toThrow("must be one of");
    expect(codexServiceTier("bogus")).toBeUndefined();
  } finally {
    values.splice(0, values.length, ...original);
  }
});
