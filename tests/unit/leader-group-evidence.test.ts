/** Terminal group evidence crosses every retained pass without hiding moved members (C-LIFE-14). */
import { expect, test } from "vitest";
import { withTerminalLeaderGroup } from "../../src/runtime/shutdown/leader-group-evidence.ts";
import { errno, hook, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

test("C-LIFE-14 terminal leader groups refuse every later signal but retain moved original identities", async () => {
  const moved = { ...leaderRow, pgid: 5002 };
  const rows = [leaderRow, moved, hook(5003)];
  let gone = false;
  const fake = scripted([rows], {
    continueGroup: () => {
      throw errno("ESRCH");
    },
  });
  const ops = withTerminalLeaderGroup(
    LEADER,
    { ...fake.ops, listProcessesUnreferenced: fake.ops.listProcesses },
    () => gone,
    () => {
      gone = true;
    },
  );
  expect(
    withTerminalLeaderGroup(
      LEADER,
      fake.ops,
      () => gone,
      () => {},
    ).listProcessesUnreferenced,
  ).toBeUndefined();
  expect(await ops.listProcesses(1000)).toHaveLength(3);
  expect(() => ops.continueGroup(5003)).toThrow("ESRCH");
  expect(gone).toBe(false);
  expect(() => ops.continueGroup(LEADER)).toThrow("ESRCH");
  expect(gone).toBe(true);
  const before = [...fake.calls];
  ops.killGroup(LEADER);
  expect(() => ops.stopGroup(LEADER)).toThrow("gone");
  expect(() => ops.continueGroup(LEADER)).toThrow("gone");
  expect(fake.calls).toEqual(before);
  expect(await ops.listProcesses(1000)).toEqual([moved, hook(5003)]);
  expect(await ops.listProcessesUnreferenced!(1000)).toEqual([moved, hook(5003)]);
  ops.stopGroup(5002);
  ops.killGroup(5002);
  expect(fake.calls).toContain("stop 5002");
  expect(fake.calls).toContain("kill 5002");
});
