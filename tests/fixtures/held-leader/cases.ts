/** Explicit held-leader failure cases and expected effects (PRD §5.3, C-LIFE-10). */
import type { heldLeader } from "../../helpers/held-leader.ts";
import { errno, LEADER, leaderRow } from "../../helpers/scripted-process-tree.ts";

export const authorizationError = errno("EIO");

export const priorRefusalCases = [
  {
    reason: "gone",
    setup: (run: ReturnType<typeof heldLeader>) => {
      run.signal.observation = { kind: "gone" };
    },
  },
  {
    reason: "exited",
    setup: (run: ReturnType<typeof heldLeader>) => {
      run.signal.leaderExited = () => true;
    },
  },
  {
    reason: "retained refusal",
    setup: (run: ReturnType<typeof heldLeader>) => {
      run.signal.guard.assertRetainedAuthority = () => {
        throw errno("EPERM");
      };
    },
  },
  {
    reason: "mismatched identity",
    setup: (run: ReturnType<typeof heldLeader>) => {
      run.signal.pid = LEADER + 1;
    },
  },
];

export const pendingRestorationCases = [
  {
    row: { ...leaderRow, stopped: true },
    done: true,
    calls: [[LEADER]],
    debt: [],
    afterStoppedCalls: [[LEADER]],
  },
  {
    row: { ...leaderRow, stopped: true, startedAt: "Sun Oct 25 22:00:09 2026" },
    done: true,
    calls: [],
    debt: [],
    afterStoppedCalls: [],
  },
  {
    row: { ...leaderRow, stopped: true, pgid: LEADER + 1 },
    done: true,
    calls: [],
    debt: [],
    afterStoppedCalls: [],
  },
  { row: leaderRow, done: false, calls: [], debt: [LEADER], afterStoppedCalls: [[LEADER]] },
  { row: { ...leaderRow, zombie: true }, done: true, calls: [], debt: [], afterStoppedCalls: [] },
];

export const signalFailureCases = [
  {
    phase: "TERM",
    setup: (run: ReturnType<typeof heldLeader>) => {
      run.signal.send = () => {
        throw authorizationError;
      };
    },
    refused: [],
  },
  {
    phase: "authorization",
    setup: (run: ReturnType<typeof heldLeader>) => {
      run.signal.guard.authorize = () => {
        throw authorizationError;
      };
    },
    refused: [authorizationError],
  },
];
