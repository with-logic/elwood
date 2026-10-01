/** Cursor-menu clearance examines tall history without quadratic copies (C-API-31/C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { codexComposerRowsClearance } from "../../../src/codex/screen/clearance.ts";
import { cursorOptionRows } from "../../../src/core/terminal-options.ts";

afterEach(() => vi.restoreAllMocks());

test.each([
  false,
  true,
])("C-TRUST-01 isolated carets with later menu=%s use linear row copying", (menu) => {
  const rows = Array.from({ length: 1_000 }, (_, index) => `› cursor-row-${index}`);
  if (menu) rows.push("› Proceed", "  Cancel");
  rows.push("› Ask Codex to do anything", "  gpt-5.3-codex high");
  let copied = 0;
  const slice = Array.prototype.slice;
  vi.spyOn(Array.prototype, "slice").mockImplementation(function (this: unknown[], start, end) {
    const result: unknown[] = Reflect.apply(slice, this, [start, end]);
    copied += result.length;
    return result;
  });
  const result = codexComposerRowsClearance(rows);
  vi.restoreAllMocks();
  expect(result).toBe(!menu);
  expect(copied).toBeLessThan(rows.length * 10);
});

test("C-TRUST-01 resumed option scan preserves absolute rows and excludes prior prefix", () => {
  const rows = ["› Old selection", "  Old sibling", "› Current choice", "  Cancel"];
  expect(cursorOptionRows(rows)).toEqual({ firstRow: 0, lastRow: 1 });
  expect(cursorOptionRows(rows, 2)).toEqual({ firstRow: 2, lastRow: 3 });
  expect(cursorOptionRows(rows, 4)).toBeUndefined();
});
