/** TERM/EPERM interleaving shared by failed-startup adapter tests (C-LIFE-10). */
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { errno, heldLeaderRow } from "./scripted-process-tree.ts";

export function pendingGroupConfirmation(leaderPid: () => number, reapedGroups: number[]) {
  const readStarted = Promise.withResolvers<void>();
  const confirmation = Promise.withResolvers<readonly ProcessEntry[]>();
  let termSent = false;
  let confirming = false;
  const ownedLeader = () => heldLeaderRow(leaderPid());
  return {
    readStarted,
    confirmation,
    ownedLeader,
    markTermSent: () => {
      termSent = true;
    },
    ops: {
      stopGroup: () => {
        if (!termSent) return;
        confirming = true;
        throw errno("EPERM");
      },
      listProcesses: () => {
        if (!confirming) return Promise.resolve([ownedLeader()]);
        readStarted.resolve();
        return confirmation.promise;
      },
      killGroup: (pgid: number) => void reapedGroups.push(pgid),
    },
  };
}
