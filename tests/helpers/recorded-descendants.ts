/** Known original descendant evidence shared by confirmation tests (C-LIFE-10). */
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { hook, LEADER, leaderRow } from "./scripted-process-tree.ts";

export function recordedDescendants(pid = 5002): DescendantRecord {
  const record = new DescendantRecord();
  record.observeFirst([leaderRow], LEADER, Date.now());
  record.observe([leaderRow, hook(pid)], LEADER);
  return record;
}
