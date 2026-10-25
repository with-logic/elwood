/**
 * The bounded wait that holds a graceful Codex shutdown for the turn's commit
 * (PRD §5.7, C-LIFE-13): which transcript records release it, and its bound.
 */
import { afterEach, expect, test, vi } from "vitest";
import { CodexTurnCommit, turnCommitWaitMs } from "../../src/codex/session/turn-commit.ts";

const never = new Promise<never>(() => undefined);

function commit(waitForCliExitOrTimeout: (timeoutMs: number) => Promise<unknown> = () => never) {
  const order: string[] = [];
  const turn = new CodexTurnCommit(() => order.push("poll"), waitForCliExitOrTimeout);
  const shutdown = () => {
    order.push("shutdown");
    return Promise.resolve();
  };
  return { turn, order, shutdown };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Runs the wait's re-read timer a few times; the bound here never fires on its own. */
const afterPolls = () => vi.advanceTimersByTimeAsync(100);

test("C-LIFE-13 with no turn pending, shutdown starts in the same tick", () => {
  const { turn, order, shutdown } = commit();
  turn.observe({ payload: { type: "task_complete", turn_id: "t1" } });
  void turn.beforeShutdown(shutdown);
  expect(order).toEqual(["shutdown"]);
});

test.each([
  "task_complete",
  "turn_complete",
  "turn_aborted",
  "turn_failed",
])("C-LIFE-13 a %s record with the pending turn's id releases the wait", async (payloadType) => {
  const { turn, order, shutdown } = commit();
  turn.expect("t1");
  const done = turn.beforeShutdown(shutdown);
  turn.observe({ payload: { type: payloadType, turn_id: "t1" } });
  await done;
  expect(order.at(-1)).toBe("shutdown");
});

test("C-LIFE-13 no other record releases the wait, and it polls the transcript meanwhile", async () => {
  vi.useFakeTimers();
  const { turn, order, shutdown } = commit();
  turn.expect("t1");
  const done = turn.beforeShutdown(shutdown);
  for (const item of [
    "not a record",
    { payload: "not a record" },
    { payload: { type: 7, turn_id: "t1" } },
    { payload: { type: "token_count", turn_id: "t1" } },
    { payload: { type: "task_complete", turn_id: "t0" } },
    // An end record without the turn's id could be an older turn's backlog.
    { payload: { type: "task_complete" } },
    { payload: { type: "task_complete", turn_id: null } },
    { payload: { type: "task_complete", turn_id: 1 } },
  ])
    turn.observe(item);
  await afterPolls();
  expect(order).not.toContain("shutdown");
  expect(order).toContain("poll");
  turn.release("t1");
  await done;
});

test("C-LIFE-13 a blocked Stop releases the wait for its turn only", async () => {
  vi.useFakeTimers();
  const { turn, order, shutdown } = commit();
  turn.expect("t1");
  const done = turn.beforeShutdown(shutdown);
  turn.release("t0");
  await afterPolls();
  expect(order).not.toContain("shutdown");
  turn.release("t1");
  await done;
  expect(order.at(-1)).toBe("shutdown");
});

test("C-LIFE-13 the wait is bounded, and a turn not recorded in time is not waited for again", async () => {
  const bounds: number[] = [];
  const { turn, order, shutdown } = commit((timeoutMs) => {
    bounds.push(timeoutMs);
    return Promise.resolve();
  });
  turn.expect("t1");
  await turn.beforeShutdown(shutdown);
  expect(bounds).toEqual([turnCommitWaitMs]);
  expect(turnCommitWaitMs).toBe(2_000);
  order.length = 0;
  void turn.beforeShutdown(shutdown);
  expect(order).toEqual(["shutdown"]);
});

test("C-LIFE-13 a newer Stop replaces the pending turn", async () => {
  const { turn, shutdown } = commit();
  turn.expect("t1");
  turn.expect("t2");
  const done = turn.beforeShutdown(shutdown);
  turn.observe({ payload: { type: "task_complete", turn_id: "t2" } });
  await expect(done).resolves.toBeUndefined();
});
