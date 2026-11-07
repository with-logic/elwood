/** Preserve terminal whole-group evidence across retained shutdown passes (PRD §9.4, C-LIFE-10). */
import { errnoCode } from "../../core/errors.ts";
import type { ProcessTreeOps } from "./process-tree-ops.ts";

/** An empty original group cannot regain authority when its numeric ID is reused. */
export function withLeaderGroupDisappearanceGuard(
  leaderGroupId: number,
  ops: ProcessTreeOps,
  isLeaderGroupGone: () => boolean,
  markLeaderGroupGone: () => void,
): ProcessTreeOps {
  const assertPresent = (group: number) => {
    if (group === leaderGroupId && isLeaderGroupGone())
      throw Object.assign(new Error("The original leader group is gone."), { code: "ESRCH" });
  };
  const read =
    (list: ProcessTreeOps["listProcesses"]): ProcessTreeOps["listProcesses"] =>
    async (ms, scope) =>
      (await list(ms, scope)).filter((row) => row.pgid !== leaderGroupId || !isLeaderGroupGone());
  return {
    ...ops,
    killGroup: (group) => {
      if (group !== leaderGroupId || !isLeaderGroupGone()) ops.killGroup(group);
    },
    stopGroup: (group) => {
      assertPresent(group);
      ops.stopGroup(group);
    },
    continueGroup: (group) => {
      assertPresent(group);
      try {
        ops.continueGroup(group);
      } catch (error) {
        if (group === leaderGroupId && errnoCode(error) === "ESRCH") markLeaderGroupGone();
        throw error;
      }
    },
    listProcesses: read(ops.listProcesses),
    ...(ops.listProcessesUnreferenced === undefined
      ? {}
      : { listProcessesUnreferenced: read(ops.listProcessesUnreferenced) }),
  };
}
