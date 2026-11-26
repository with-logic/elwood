/**
 * Each conformance criterion ID in PRD §14 names exactly one row, so a test title that cites
 * an ID points at one criterion (prd/14-conformance.md).
 */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const table = readFileSync(new URL("../../prd/14-conformance.md", import.meta.url), "utf8");
const rowIds = table
  .split("\n")
  .flatMap((line) => /^\| (C-[A-Z0-9]+-\d+) \|/.exec(line)?.[1] ?? []);

// A loose floor, well below the table's real size, so a parse that stops matching most rows
// fails here instead of passing with too few IDs to compare. It is not the expected count.
const MIN_PARSED_CRITERION_ROWS = 300;

test("every conformance criterion ID names exactly one row", () => {
  expect(rowIds.length).toBeGreaterThan(MIN_PARSED_CRITERION_ROWS);
  expect(rowIds.filter((id, index) => rowIds.indexOf(id) !== index)).toEqual([]);
});
