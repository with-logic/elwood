/**
 * Aligned table rendering shared by the listing commands.
 * Covers PRD §12A.8/§12A.10 and C-CLI-22/C-CLI-24.
 */

import { expect, test } from "vitest";
import { renderTable } from "../../src/cli/table.ts";

test("C-CLI-22 renders a header-first table with padded columns and no trailing blanks", () => {
  expect(renderTable(["A", "LONG"], [["x", "y"], ["longer", ""], ["z"]])).toBe(
    ["A       LONG", "x       y", "longer", "z", ""].join("\n"),
  );
  expect(renderTable(["ONLY"], [])).toBe("ONLY\n");
});
