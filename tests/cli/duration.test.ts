/** Duration-boundary coverage for the CLI. Covers PRD C-CLI-07/C-CLI-14. */

import { describe, expect, test } from "vitest";
import { parseDuration } from "../../src/cli/duration.ts";

describe("CLI duration", () => {
  test.each([
    ["1ms", 1],
    ["2s", 2_000],
    ["3m", 180_000],
    ["4h", 14_400_000],
  ])("parses %s", (value, expected) => expect(parseDuration(value)).toBe(expected));

  test.each(["", "0s", "01s", "1", "-1s", "1d"])("rejects %s", (value) => {
    expect(() => parseDuration(value)).toThrow(/positive integer/iu);
  });

  test("rejects an unsafe millisecond product", () => {
    expect(() => parseDuration("9007199254740991h")).toThrow(/safe integer/iu);
  });
});
