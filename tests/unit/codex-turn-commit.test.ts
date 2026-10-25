/**
 * The bounded wait that holds a graceful Codex shutdown for the turn's commit
 * (PRD §5.7, C-LIFE-13): which transcript records release it, and its bound.
 */
import { expect, test } from "vitest";
import { CodexTurnCommit, turnCommitWaitMs } from "../../src/codex/session/turn-commit.ts";

const never = new Promise<never>(() => undefined);

function commit(exited: (timeoutMs: number) => Promise<unknown> = () => never) {
  const order: string[] = [];
  const turn = new CodexTurnCommit(() => order.push("scan"), exited);
  const shutdown = () => {
    order.push("shutdown");
    return Promise.resolve();
  };
  return { turn, order, shutdown };
}

test("C-LIFE-13 with no turn pending, shutdown starts in the same tick", () => {
  const { turn, order, shutdown } = commit();
  turn.observe({ payload: { type: "task_complete", turn_id: "t1" } });
  void turn.before(shutdown);
  expect(order).toEqual(["shutdown"]);
});

test("C-LIFE-13 only the pending turn's end releases the wait", async () => {
  const { turn, order, shutdown } = commit();
  turn.expect("t1");
  const done = turn.before(shutdown);
  for (const item of [
    "not a record",
    { payload: "not a record" },
    { payload: { type: 7 } },
    { payload: { type: "token_count", turn_id: "t1" } },
    { payload: { type: "task_complete", turn_id: "t0" } },
  ])
    turn.observe(item);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(order).not.toContain("shutdown");
  expect(order).toContain("scan");
  turn.observe({ payload: { type: "turn_failed", turn_id: "t1" } });
  await done;
  expect(order.at(-1)).toBe("shutdown");
});

test("C-LIFE-13 the wait is bounded, and a commit that never came is not waited for again", async () => {
  const bounds: number[] = [];
  const { turn, order, shutdown } = commit((timeoutMs) => {
    bounds.push(timeoutMs);
    return Promise.resolve();
  });
  turn.expect("t1");
  await turn.before(shutdown);
  expect(bounds).toEqual([turnCommitWaitMs]);
  expect(turnCommitWaitMs).toBe(2_000);
  order.length = 0;
  void turn.before(shutdown);
  expect(order).toEqual(["shutdown"]);
});

test("C-LIFE-13 a newer Stop replaces the pending turn", async () => {
  const { turn, shutdown } = commit();
  turn.expect("t1");
  turn.expect("t2");
  const done = turn.before(shutdown);
  turn.observe({ payload: { type: "task_complete", turn_id: "t2" } });
  await expect(done).resolves.toBeUndefined();
});
