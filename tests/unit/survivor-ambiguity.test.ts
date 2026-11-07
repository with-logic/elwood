/** First-record ambiguity cannot authorize a colliding PID/PGID (PRD §5.3, C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import { watchDescendants } from "../../src/runtime/shutdown/detached-sweep/watch-descendants.ts";
import {
  hook,
  LEADER,
  leaderRow,
  STARTED_AT,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();
const EPOCH = Date.parse(`${STARTED_AT} UTC`) + 500;
const leader = { ...leaderRow, startedAt: "Sun Oct 25 21:59:00 2026" };
afterEach(() => vi.restoreAllMocks());

test.each([
  STARTED_AT,
  "unparseable",
])("C-LIFE-10 first ambiguous descendant %s never ages into kill authority", async (startedAt) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(EPOCH);
  const ambiguous = hook(10_000_001, { startedAt });
  const safe = hook(10_000_002, { startedAt: leader.startedAt });
  const record = new DescendantRecord();
  record.observeFirst([leader], LEADER, EPOCH);
  record.observe([leader, ambiguous, safe], LEADER);
  clock.mockReturnValue(EPOCH + 5_000);
  record.observe([leader, ambiguous, safe], LEADER);
  const fake = scripted([[ambiguous, safe]]);
  expect((await reapRecordedSurvivors(record, fake.ops))?.processGroupIds).toEqual([
    ambiguous.pgid,
  ]);
  expect(fake.calls).not.toContain(`stop ${ambiguous.pgid}`);
  expect(fake.calls).toContain(`kill ${safe.pgid}`);
});

test("C-LIFE-10 a slow first record uses its native read-start epoch", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(EPOCH);
  const pending = Promise.withResolvers<readonly (typeof leader)[]>();
  const watch = watchDescendants(LEADER, { listProcesses: () => pending.promise }, () => false);
  clock.mockReturnValue(EPOCH + 5_000);
  const child = hook(10_000_001);
  pending.resolve([leader, child]);
  await watch.firstRead;
  const record = await watch.finish();
  const fake = scripted([[child]]);
  expect((await reapRecordedSurvivors(record, fake.ops))?.processGroupIds).toEqual([child.pgid]);
  expect(fake.calls).toEqual(["list"]);
});

test("C-LIFE-10 a newly ambiguous member revokes its held group's authority", async () => {
  vi.spyOn(Date, "now").mockReturnValue(EPOCH);
  const parent = hook(10_000_001, { startedAt: leader.startedAt });
  const born = hook(10_000_002, { pgid: parent.pgid });
  const record = new DescendantRecord();
  record.observeFirst([leader], LEADER, EPOCH);
  record.observe([leader, parent], LEADER, EPOCH);
  const fake = scripted([[parent], [parent, born]]);
  expect(await reapRecordedSurvivors(record, fake.ops)).toBeDefined();
  expect(fake.calls).toContain(`cont ${parent.pgid}`);
  expect(fake.calls).not.toContain(`kill ${parent.pgid}`);
  expect(record.pids).toContain(born.pid);
});
