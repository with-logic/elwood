/** Observing surviving updater groups preserves lease exclusion (PRD §9.2, C-PERF-04). */
import { afterEach, expect, test, vi } from "vitest";
import { waitForProbeGroups } from "../../src/runtime/probe/cleanup.ts";

afterEach(() => vi.restoreAllMocks());
const group = 500_000_001;

test("C-PERF-04 an empty group set is already gone", async () => {
  expect(await waitForProbeGroups([])).toEqual([]);
});

test("C-PERF-04 an absent group is not retained", async () => {
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  expect(await waitForProbeGroups([group])).toEqual([]);
});

test("C-PERF-04 observation notices a group that exits during its window without signaling it", async () => {
  let observed = 0;
  const send = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    expect(signal).toBe(0);
    if (observed++ === 0) return true;
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  expect(await waitForProbeGroups([group])).toEqual([]);
  expect(send).toHaveBeenCalledTimes(2);
});

test("C-PERF-04 a still-live group remains excluded when observation ends", async () => {
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    expect(signal).toBe(0);
    return true;
  });
  expect(await waitForProbeGroups([group])).toEqual([group]);
});
