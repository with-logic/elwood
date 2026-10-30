/** A survivor watch's held-leader boundary rejects gone or invalid leaders without signals (C-LIFE-10). */
import { expect, test, vi } from "vitest";
import { watchSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import { leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

test.each([
  "gone",
  "exit callback",
  "invalid",
] as const)("C-LIFE-10 a %s leader receives no held signal", async (kind) => {
  const { ops, calls } = scripted([kind === "gone" ? [] : [leaderRow]]);
  const exited = () => kind === "exit callback";
  const watch = watchSurvivors(
    kind === "invalid" ? undefined : leaderRow.pid,
    ops,
    exited,
    () => {},
  );
  await watch.firstRead;
  const send = vi.fn();
  expect(await watch.sendSignal(send)).toBe(true);
  await watch.finish();
  expect(send).not.toHaveBeenCalled();
  expect(calls.filter((call) => call.startsWith("stop"))).toEqual([]);
});
