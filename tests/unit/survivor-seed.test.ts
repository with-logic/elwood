/** Fresh recovery reads seed a survivor pass, never post-stop authority (PRD §5.3, C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import {
  errno,
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();
afterEach(() => vi.restoreAllMocks());
const orphan = hook(5002, { ppid: 1 });
function recorded() {
  const record = new DescendantRecord();
  record.observe([leaderRow, hook(5002)], LEADER);
  return record;
}

test("C-LIFE-10 a fresh initial table replaces only the pre-stop scan", async () => {
  const fake = scripted([[orphan]]);
  expect(
    await reapRecordedSurvivors(recorded(), fake.ops, undefined, {
      table: [orphan],
      readStartedAtEpochMs: Date.now(),
    }),
  ).toBeUndefined();
  expect(fake.calls).toEqual(["stop 5002", "list", "list", "kill 5002"]);
});

test("C-LIFE-10 a seed cannot replace the fresh identity read after SIGSTOP", async () => {
  const replacement = { ...orphan, startedAt: "Sun Oct 25 22:00:09 2026" };
  const fake = scripted([[replacement]]);
  expect(
    await reapRecordedSurvivors(recorded(), fake.ops, undefined, {
      table: [orphan],
      readStartedAtEpochMs: Date.now(),
    }),
  ).toBeDefined();
  expect(fake.calls).toEqual(["stop 5002", "list", "cont 5002"]);
});

test("C-LIFE-10 an unreadable first post-stop table restores the seeded hold", async () => {
  const fake = scripted([], { listProcesses: () => Promise.reject(errno("EIO")) });
  expect(
    await reapRecordedSurvivors(recorded(), fake.ops, undefined, {
      table: [orphan],
      readStartedAtEpochMs: Date.now(),
    }),
  ).toBeDefined();
  expect(fake.calls).toEqual(["stop 5002", "cont 5002"]);
});

test("C-LIFE-10 new child ambiguity uses the seed's read-start epoch", async () => {
  const epoch = Date.parse("2026-10-25T22:00:00.500Z");
  const older = "Sun Oct 25 21:59:00 2026";
  const parent = { ...orphan, startedAt: older };
  const child = hook(5003, { ppid: 5002 });
  const record = new DescendantRecord();
  record.observe(
    [
      { ...leaderRow, startedAt: older },
      { ...parent, ppid: LEADER },
    ],
    LEADER,
  );
  vi.spyOn(Date, "now").mockReturnValue(epoch + 5000);
  const fake = scripted([[parent, child]]);
  const failure = await reapRecordedSurvivors(record, fake.ops, undefined, {
    table: [parent, child],
    readStartedAtEpochMs: epoch,
  });
  expect(failure?.processGroupIds).toEqual([5003]);
  expect(fake.calls).toContain("kill 5002");
  expect(fake.calls).not.toContain("stop 5003");
});
