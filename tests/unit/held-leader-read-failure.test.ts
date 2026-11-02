/** Safe first-read causes and zombie-only refused holds (C-LIFE-10/C-ERR-01). */
import { afterEach, expect, test, vi } from "vitest";
import { watchSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivor-watch.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { heldLeaderHarness as harness } from "../helpers/held-leader.ts";
import { errno, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

afterEach(() => vi.restoreAllMocks());

test.each([
  "EIO",
  "not a safe errno",
])("C-ERR-01 first-read cause preserves only safe errno (%s)", async (code) => {
  const run = harness({
    firstReadError: Object.assign(new Error("secret process output"), { code }),
  });
  const failure = await run.stop().catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: "termination_failed",
    details: { cause: "First leader process-table read failed." },
  });
  expect(String(failure)).not.toContain("secret process output");
  if (code === "EIO") expect(failure).toMatchObject({ details: { errno: "EIO" } });
  else expect(failure).not.toHaveProperty("details.errno");
  expect(run.ops.killGroup).not.toHaveBeenCalled();
});

test.each([
  "goneOnStop",
  "zombieOnStop",
] as const)("C-LIFE-10 EPERM with %s confirms normal exit", async (kind) => {
  const run = harness({ stopError: errno("EPERM"), [kind]: true });
  await expect(run.stop()).resolves.toBeUndefined();
  expect(run.signals).toEqual([]);
  expect(run.timeouts).toHaveLength(2);
  expect(run.timeouts[1]).toBeLessThanOrEqual(10_000);
});

test("C-LIFE-10 unreadable EPERM confirmation retains its bounded failure", async () => {
  const run = harness({ stopError: errno("EPERM"), postStopError: errno("EIO") });
  await expect(run.stop()).rejects.toMatchObject({
    code: "termination_failed",
    details: { errno: "EIO" },
  });
  expect(run.signals).toEqual([]);
  expect(run.ops.killGroup).not.toHaveBeenCalled();
});

test("C-LIFE-10 a standalone signal requested before its pending first observation is refused", async () => {
  const pending = Promise.withResolvers<readonly ProcessEntry[]>();
  const fake = scripted([]);
  const watch = watchSurvivors(
    leaderRow.pid,
    { ...fake.ops, listProcesses: () => pending.promise },
    () => false,
    () => {},
  );
  const send = vi.fn();
  try {
    await expect(watch.sendSignal(send)).rejects.toThrow("No recorded leader identity");
    expect(send).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  } finally {
    pending.resolve([leaderRow]);
    await watch.finish();
  }
});

test.each([
  "exitOnStop",
  "exitAfterRead",
] as const)("C-LIFE-10 EPERM confirmation honors %s even if its read would fail", async (when) => {
  const run = harness({ stopError: errno("EPERM"), postStopError: errno("EIO"), [when]: true });
  await expect(run.stop()).resolves.toBeUndefined();
  expect(run.signals).toEqual([]);
});
