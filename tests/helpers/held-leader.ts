/** Scripted held-leader boundary, without PTYs or native signals (PRD §5.3, C-LIFE-10). */
import { sendHeldLeaderSignal } from "../../src/runtime/shutdown/detached-sweep/held-leader.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import type { SweepOps } from "../../src/runtime/shutdown/detached-sweep/rounds.ts";
import { LEADER, leaderRow, scripted } from "./scripted-process-tree.ts";

export function heldLeader(ops: SweepOps = scripted([[leaderRow]]).ops) {
  const record = new DescendantRecord();
  const observation = record.observeFirst([leaderRow], LEADER, Date.now());
  const delivered: string[] = [];
  const refused: unknown[] = [];
  let authorized = false;
  let gone = false;
  const signal = {
    pid: LEADER,
    record,
    observation,
    ops,
    leaderExited: () => false,
    deadline: performance.now() + 10_000,
    guard: {
      serialize: <T>(attempt: () => Promise<T>): Promise<T> => attempt(),
      assertRetainedAuthority: () => undefined,
      authorize: () => {
        authorized = true;
      },
      forbid: (error: unknown) => {
        refused.push(error);
      },
      gone: () => {
        gone = true;
      },
    },
    send: () => {
      delivered.push(authorized ? "TERM" : "unauthorized TERM");
    },
  };
  return {
    signal,
    record,
    delivered,
    refused,
    groupGone: () => gone,
    run: () => sendHeldLeaderSignal(signal),
  };
}
