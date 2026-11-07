/** Preserve terminal whole-group evidence across retained shutdown passes (PRD §9.4, C-LIFE-14). */
import { errnoCode } from "../../core/errors.ts";
import type { ProcessTreeOps } from "./process-tree-ops.ts";

/** An empty original group cannot regain authority when its numeric ID is reused. */
export function withTerminalLeaderGroup(
  leader: number,
  ops: ProcessTreeOps,
  gone: () => boolean,
  markGone: () => void,
): ProcessTreeOps {
  const assertPresent = (group: number) => {
    if (group === leader && gone())
      throw Object.assign(new Error("The original leader group is gone."), { code: "ESRCH" });
  };
  const read =
    (list: ProcessTreeOps["listProcesses"]): ProcessTreeOps["listProcesses"] =>
    async (ms, scope) =>
      (await list(ms, scope)).filter((row) => row.pgid !== leader || !gone());
  return {
    ...ops,
    killGroup: (group) => {
      if (group !== leader || !gone()) ops.killGroup(group);
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
        if (group === leader && errnoCode(error) === "ESRCH") markGone();
        throw error;
      }
    },
    listProcesses: read(ops.listProcesses),
    ...(ops.listProcessesUnreferenced === undefined
      ? {}
      : { listProcessesUnreferenced: read(ops.listProcessesUnreferenced) }),
  };
}
