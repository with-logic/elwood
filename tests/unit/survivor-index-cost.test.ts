/** Avoid unused process-table indexes during cleanup (PRD §5.3, C-LIFE-10). */
import { expect, test } from "vitest";
import { SweepFailures } from "../../src/runtime/shutdown/detached-sweep/failures.ts";
import { killOrResumeSignaledGroups } from "../../src/runtime/shutdown/detached-sweep/kill.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { newSweepState, stopGroup } from "../../src/runtime/shutdown/detached-sweep/rounds.ts";
import { SurvivorAnchors } from "../../src/runtime/shutdown/detached-sweep/survivor-anchors.ts";
import { survivorAndDescendantGroups } from "../../src/runtime/shutdown/detached-sweep/survivor-groups.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import {
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();

function createPgidReadCountingTable(count = 500) {
  let pgidReads = 0;
  const rows = Array.from({ length: count }, (_, index) => {
    const pid = 6000 + index;
    const row = hook(pid, { ppid: 1 });
    Object.defineProperty(row, "pgid", {
      get: () => {
        pgidReads += 1;
        return pid;
      },
    });
    return row;
  });
  return {
    rows,
    pgidReads: () => pgidReads,
    resetPgidReads: () => {
      pgidReads = 0;
    },
  };
}

test("C-LIFE-10 empty survivor roots inspect no process groups", () => {
  const table = createPgidReadCountingTable();
  expect(survivorAndDescendantGroups([], table.rows, process.pid)).toEqual({
    roots: new Set(),
    groups: new Map(),
  });
  expect(table.pgidReads()).toBe(0);
});

test("C-LIFE-10 an empty kill pass builds no daemon resume index", async () => {
  const table = createPgidReadCountingTable();
  const state = newSweepState(new SweepFailures());
  state.latest = table.rows;
  const fake = scripted([]);
  await killOrResumeSignaledGroups(fake.ops, state, performance.now() + 1000);
  expect(table.pgidReads()).toBe(0);
  expect(fake.calls).toEqual([]);
});

test("C-LIFE-10 vanished recorded survivors build no group indexes", async () => {
  const record = new DescendantRecord();
  record.observeFirst([leaderRow], LEADER, Date.now());
  record.observe([leaderRow, hook(5002)], LEADER, Date.now());
  const table = createPgidReadCountingTable();
  const fake = scripted([], { listProcesses: () => Promise.resolve(table.rows) });
  expect(await reapRecordedSurvivors(record, fake.ops)).toBeUndefined();
  expect(table.pgidReads()).toBe(0);
  expect(fake.calls).toEqual([]);
});

test("C-LIFE-10 restoring many unconfirmed groups reuses the latest read index", () => {
  const table = createPgidReadCountingTable();
  const originals = table.rows.slice(0, 50);
  const record = new DescendantRecord();
  const state = newSweepState(new SweepFailures());
  const fake = scripted([]);
  const anchors = new SurvivorAnchors(state, record, fake.ops);
  state.latest = originals;
  anchors.afterRead(originals);
  for (const row of originals) stopGroup(row.pgid, anchors.stoppingOps(), state);
  // A fresh read still shows running originals: restore them without rescanning unrelated rows.
  state.latest = table.rows;
  anchors.afterRead(table.rows);
  table.resetPgidReads();
  anchors.restoreUnconfirmed();
  expect(fake.calls.filter((call) => call.startsWith("cont"))).toEqual(
    originals.map((row) => `cont ${row.pid}`),
  );
  expect(table.pgidReads()).toBe(0);
  expect(state.signaledDescendantGroupIds).toEqual([]);
  expect(anchors.rejected).toEqual(new Set(originals.map((row) => row.pid)));
  expect(state.failures.result()?.message).toContain("could not be safely confirmed stopped");
});
