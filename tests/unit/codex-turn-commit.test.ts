/**
 * The bounded wait that holds a graceful Codex shutdown for the turn's commit
 * (PRD §5.7, C-LIFE-13): which transcript records release it, its bound, and the
 * report when the bound ends it.
 */
import { afterEach, expect, test, vi } from "vitest";
import { CodexTurnCommit, turnCommitWaitMs } from "../../src/codex/session/turn-commit.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";

const never = new Promise<never>(() => undefined);

type Warnings = readonly ElwoodWarningEvent[];

/** The session's `emitWarnings` defaults to recording each warning's code in `order`. */
function commit(
  within: (timeoutMs: number) => Promise<boolean> = () => never,
  emitWarnings?: (warnings: Warnings) => void,
) {
  const order: string[] = [];
  const session = {
    elwoodSessionId: "s1",
    emitWarnings:
      emitWarnings ?? ((warnings: Warnings) => order.push(...warnings.map((w) => w.code))),
  };
  const turn = new CodexTurnCommit(() => order.push("poll"), { within }, session);
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

test("C-LIFE-13 the bound ends the wait and is reported, and that turn is not waited for again", async () => {
  const bounds: number[] = [];
  const { turn, order, shutdown } = commit((timeoutMs) => {
    bounds.push(timeoutMs);
    return Promise.resolve(false);
  });
  turn.expect("t1");
  await turn.beforeShutdown(shutdown);
  expect(bounds).toEqual([turnCommitWaitMs]);
  expect(turnCommitWaitMs).toBe(2_000);
  expect(order.slice(-2)).toEqual(["turn_commit_wait_expired", "shutdown"]);
  order.length = 0;
  void turn.beforeShutdown(shutdown);
  expect(order).toEqual(["shutdown"]);
});

test("C-LIFE-13 neither the CLI's exit nor the turn's record is reported as expiry", async () => {
  const exited = commit(() => Promise.resolve(true));
  exited.turn.expect("t1");
  await exited.turn.beforeShutdown(exited.shutdown);
  const recorded = commit();
  recorded.turn.expect("t1");
  const done = recorded.turn.beforeShutdown(recorded.shutdown);
  recorded.turn.observe({ payload: { type: "task_complete", turn_id: "t1" } });
  await done;
  expect([...exited.order, ...recorded.order]).not.toContain("turn_commit_wait_expired");
});

test("C-LIFE-13 a failing expiry report does not keep Codex running", async () => {
  const { turn, order, shutdown } = commit(
    () => Promise.resolve(false),
    () => {
      throw new Error("warning listener failed");
    },
  );
  turn.expect("t1");
  await turn.beforeShutdown(shutdown);
  expect(order.at(-1)).toBe("shutdown");
});

test("C-LIFE-13 a newer Stop replaces the pending turn", async () => {
  const { turn, shutdown } = commit();
  turn.expect("t1");
  turn.expect("t2");
  const done = turn.beforeShutdown(shutdown);
  turn.observe({ payload: { type: "task_complete", turn_id: "t2" } });
  await expect(done).resolves.toBeUndefined();
});

test("C-LIFE-13 overlapping shutdowns share one wait and one expiry report", async () => {
  let waits = 0;
  const { turn, order, shutdown } = commit(() => {
    waits += 1;
    return Promise.resolve(false);
  });
  turn.expect("t1");
  await Promise.all([turn.beforeShutdown(shutdown), turn.beforeShutdown(shutdown)]);
  expect(waits).toBe(1);
  expect(order.filter((step) => step === "turn_commit_wait_expired")).toHaveLength(1);
  expect(order.filter((step) => step === "shutdown")).toHaveLength(2);
});
