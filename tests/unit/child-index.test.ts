/**
 * The process table's index of children by parent (PRD §5.3, C-LIFE-10): built once per
 * read, however many walks from different roots read that table, and never shared with
 * another read, even one whose rows are the same. Scripted tables only.
 */

import { describe, expect, test } from "vitest";
import { childrenByParent } from "../../src/runtime/shutdown/process-table.ts";
import { hook, leaderRow } from "../helpers/scripted-process-tree.ts";

describe("C-LIFE-10 the index of children by parent", () => {
  test("is built once per read, and never shared with another read", () => {
    const table = [leaderRow, hook(5002), hook(5003, { ppid: 5002, pgid: 5002 })];
    const index = childrenByParent(table);
    expect(index.get(5002)?.map((row) => row.pid)).toEqual([5003]);
    expect(childrenByParent(table)).toBe(index);
    expect(childrenByParent([...table])).not.toBe(index);
    expect(childrenByParent([...table])).toEqual(index);
  });
});
