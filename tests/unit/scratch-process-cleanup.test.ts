/** Bounded scratch fixture cleanup preserves all failures (PRD §12, C-E2E-03). */

import { afterEach, expect, test, vi } from "vitest";
import { endAll, runWithCleanup } from "../e2e/scratch-processes/cleanup.ts";
import { processRows } from "../helpers/process-liveness.ts";

vi.mock("../helpers/process-liveness.ts", async (original) => ({
  ...(await original<typeof import("../helpers/process-liveness.ts")>()),
  processRows: vi.fn(() => []),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(processRows).mockReset().mockReturnValue([]);
});

test("C-E2E-03 every cleanup runs after a successful body", async () => {
  const actions: string[] = [];
  await runWithCleanup(() => {
    actions.push("body");
  }, [
    () => {
      actions.push("first");
    },
    async () => {
      await Promise.resolve();
      actions.push("second");
    },
  ]);
  expect(actions).toEqual(["body", "first", "second"]);
});

test.each([
  true,
  false,
])("C-E2E-03 a sole failure keeps its identity (body=%s)", async (bodyFails) => {
  const failure = new Error("original");
  const fail = () => {
    throw failure;
  };
  await expect(
    runWithCleanup(bodyFails ? fail : () => {}, [bodyFails ? () => {} : fail]),
  ).rejects.toBe(failure);
});

test("C-E2E-03 body and every cleanup failure are reported together", async () => {
  const failures = [new Error("body"), new Error("cleanup one"), new Error("cleanup two")];
  const actions: string[] = [];
  const run = runWithCleanup(() => {
    throw failures[0];
  }, [
    () => {
      throw new AggregateError(failures.slice(1), "cleanup failures");
    },
    () => {
      actions.push("last cleanup");
    },
  ]);
  await expect(run).rejects.toMatchObject({ errors: failures });
  expect(actions).toEqual(["last cleanup"]);
});

test("C-E2E-03 each fallback table read uses the remaining cleanup deadline", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  const row = { pid: 10_000_000, ppid: 1, pgid: 10_000_000, stat: "S", command: "fixture" };
  vi.mocked(processRows).mockReturnValueOnce([row]).mockReturnValueOnce([row]);
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const cleanup = endAll([row]);
  await vi.advanceTimersByTimeAsync(100);
  await cleanup;
  expect(processRows).toHaveBeenCalledTimes(4);
  expect(vi.mocked(processRows).mock.calls.map(([timeout]) => timeout)).toEqual([
    10_000, 10_000, 9_900, 9_900,
  ]);
  expect(kill).toHaveBeenCalledWith(row.pid, "SIGTERM");
});
