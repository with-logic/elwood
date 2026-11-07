/** Held snapshots retain original group helpers without inventing unseen ownership (C-LIFE-10). */
import { expect, test, vi } from "vitest";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { watchSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivor-watch.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import {
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";
import { survivorGuard } from "../helpers/survivor-guard.ts";

useScriptedHost();
const helper = hook(5001, { pgid: LEADER });
const orphan = { ...helper, ppid: 1 };
const detached = hook(5002);

test.each([
  {
    phase: "initial",
    first: [leaderRow, helper],
    held: [leaderRow, helper],
    after: [orphan],
    group: LEADER,
  },
  { phase: "held", first: [leaderRow], held: [leaderRow, helper], after: [orphan], group: LEADER },
  {
    phase: "held detached",
    first: [leaderRow],
    held: [leaderRow, detached],
    after: [{ ...detached, ppid: 1 }],
    group: detached.pgid,
  },
])("C-LIFE-10 a helper captured by the $phase read is killed after leader exit", async ({
  first,
  held,
  after,
  group,
}) => {
  const fake = scripted([first, held, after]);
  const keep = vi.fn();
  let exited = false;
  const watch = watchSurvivors(LEADER, fake.ops, () => exited, keep, survivorGuard());
  await watch.sendSignal(() => {
    exited = true;
  });
  await watch.finish();
  expect(fake.calls.filter((call) => call === `kill ${group}`)).toEqual([`kill ${group}`]);
  expect(keep).toHaveBeenCalledExactlyOnceWith(undefined, expect.anything());
});

test("C-LIFE-10 held-read identity age is measured before the read begins", async () => {
  let clock = Date.parse("Sun Oct 25 22:00:10 2026 UTC");
  const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
  const recent = { ...helper, startedAt: "Sun Oct 25 22:00:10 2026" };
  const fake = scripted([[leaderRow], [leaderRow, recent], [{ ...recent, ppid: 1 }]]);
  const keep = vi.fn();
  let reads = 0;
  let exited = false;
  try {
    const watch = watchSurvivors(
      LEADER,
      {
        ...fake.ops,
        listProcesses: (timeout, scope) => {
          const result = fake.ops.listProcesses(timeout, scope);
          if (++reads === 2) clock += 1_100;
          return result;
        },
      },
      () => exited,
      keep,
      survivorGuard(),
    );
    await watch.sendSignal(() => {
      exited = true;
    });
    await watch.finish();
    expect(fake.calls).not.toContain(`kill ${LEADER}`);
    expect(keep).toHaveBeenCalledWith(
      expect.objectContaining({ processGroupIds: [LEADER] }),
      expect.anything(),
    );
  } finally {
    now.mockRestore();
  }
});

test("C-LIFE-10 unattributable live leader-group members keep cleanup unresolved", async () => {
  const record = new DescendantRecord();
  record.observeFirst([leaderRow], LEADER, Date.now());
  record.observeLeaderGroup([leaderRow], LEADER, Date.now());
  const fake = scripted([[orphan]]);
  expect(await reapRecordedSurvivors(record, fake.ops)).toMatchObject({
    message: expect.stringContaining("a survivor group has an ambiguous identity"),
    processGroupIds: [LEADER],
  });
  expect(fake.calls).toEqual(["list"]);
  const later = scripted([[]]);
  expect(await reapRecordedSurvivors(record, later.ops)).toMatchObject({
    processGroupIds: [LEADER],
  });
  expect(later.calls).toEqual(["list"]);
});

test("C-LIFE-10 a recorded member becoming shared does not lose its identity", () => {
  const record = new DescendantRecord();
  record.observeFirst([leaderRow], LEADER, Date.now());
  record.observeLeaderGroup([leaderRow], LEADER, Date.now());
  expect([...record.unsafeSurvivorGroups([{ ...leaderRow, shared: true }])]).toEqual([]);
});
