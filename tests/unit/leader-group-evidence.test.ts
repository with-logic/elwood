/** Terminal group evidence crosses every retained pass without hiding moved members (C-LIFE-10). */
import { expect, test } from "vitest";
import { withLeaderGroupDisappearanceGuard } from "../../src/runtime/shutdown/leader-group-evidence.ts";
import { errno, hook, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

test("C-LIFE-10 terminal leader groups refuse every later signal but retain moved original identities", async () => {
  const moved = { ...leaderRow, pgid: 5002 };
  const rows = [leaderRow, moved, hook(5003)];
  let gone = false;
  const fake = scripted([rows], {
    continueGroup: () => {
      throw errno("ESRCH");
    },
  });
  const ops = withLeaderGroupDisappearanceGuard(
    LEADER,
    { ...fake.ops, listProcessesUnreferenced: fake.ops.listProcesses },
    () => gone,
    () => {
      gone = true;
    },
  );
  const later = withLeaderGroupDisappearanceGuard(
    LEADER,
    fake.ops,
    () => gone,
    () => {
      gone = true;
    },
  );
  expect(later.listProcessesUnreferenced).toBeUndefined();
  expect(await ops.listProcesses(1000)).toHaveLength(3);
  expect(() => ops.continueGroup(5003)).toThrow("ESRCH");
  expect(gone).toBe(false);
  expect(() => ops.continueGroup(LEADER)).toThrow("ESRCH");
  expect(gone).toBe(true);
  const before = [...fake.calls];
  ops.killGroup(LEADER);
  expect(() => ops.stopGroup(LEADER)).toThrow("gone");
  expect(() => ops.continueGroup(LEADER)).toThrow("gone");
  later.killGroup(LEADER);
  expect(() => later.stopGroup(LEADER)).toThrow("gone");
  expect(() => later.continueGroup(LEADER)).toThrow("gone");
  expect(fake.calls).toEqual(before);
  expect(await later.listProcesses(1000)).toEqual([moved, hook(5003)]);
  expect(await ops.listProcesses(1000)).toEqual([moved, hook(5003)]);
  expect(await ops.listProcessesUnreferenced!(1000)).toEqual([moved, hook(5003)]);
  ops.stopGroup(5002);
  ops.killGroup(5002);
  expect(fake.calls).toContain("stop 5002");
  expect(fake.calls).toContain("kill 5002");
});

test("C-LIFE-10 EPERM propagates without retiring later leader-group operations", () => {
  let gone = false;
  let refused = true;
  const denied = errno("EPERM");
  const fake = scripted([], {
    continueGroup: (group) => {
      fake.calls.push(`cont ${group}`);
      if (refused) throw denied;
    },
  });
  const ops = withLeaderGroupDisappearanceGuard(
    LEADER,
    fake.ops,
    () => gone,
    () => {
      gone = true;
    },
  );
  expect(() => ops.continueGroup(LEADER)).toThrow(denied);
  expect(gone).toBe(false);
  refused = false;
  ops.stopGroup(LEADER);
  ops.killGroup(LEADER);
  ops.continueGroup(LEADER);
  expect(fake.calls).toEqual([
    `cont ${LEADER}`,
    `stop ${LEADER}`,
    `kill ${LEADER}`,
    `cont ${LEADER}`,
  ]);
  expect(gone).toBe(false);
});
