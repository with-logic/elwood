/** Unknown Stop activity results share Claude's block semantics (PRD §4, §6.4). */
import { expect, test } from "vitest";
import { isBlock } from "../../src/claude/hooks/dispatch.ts";

test.each([
  [undefined, false],
  [null, false],
  ["block", false],
  [1, false],
  [true, false],
  [[], false],
  [{}, false],
  [{ decision: "block", reason: "continue the turn" }, true],
  [{ decision: "approve" }, false],
] satisfies readonly (readonly [
  unknown,
  boolean,
])[])("unknown Stop result %# reports a block only for a block decision", (result, blocked) => {
  expect(isBlock(result)).toBe(blocked);
});
