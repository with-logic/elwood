/**
 * The process-tree seam's inert defaults (PRD §5.3 and §9.4, C-LIFE-10): ops a test
 * leaves out of `setProcessTreeOpsForTests` never reach a real signal or a real
 * process-table read. Both boundaries are instrumented, and neither can act for real
 * here even if an assertion fails: `process.kill` is replaced, and the production
 * listing is mocked to count its calls and reject.
 */

import { afterEach, expect, test, vi } from "vitest";
import {
  quietProcessTree,
  resetProcessTreeOpsForTests,
  SessionReaper,
  setProcessTreeOpsForTests,
} from "../../src/runtime/shutdown/reap-tree.ts";

const listing = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../src/runtime/shutdown/process-table.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/runtime/shutdown/process-table.ts")>()),
  listProcessTableShared: () => {
    listing.calls += 1;
    return Promise.reject(new Error("the production listing was reached"));
  },
}));

// Any valid pid works: `process.kill` is replaced, so no group is ever signaled.
const LEADER = 5000;

afterEach(() => {
  vi.restoreAllMocks();
  resetProcessTreeOpsForTests();
});

test("C-LIFE-10 ops left out of the seam never reach a real signal or table read", async () => {
  const signals: unknown[] = [];
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    signals.push([pid, signal]);
    return true;
  });
  const killed: number[] = [];
  setProcessTreeOpsForTests({ killGroup: (pgid) => void killed.push(pgid) });
  const reaper = new SessionReaper(LEADER);
  await expect(reaper.sweepDetached(() => false)).resolves.toBeUndefined();
  expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).not.toThrow();
  expect(signals).toEqual([]); // no real SIGSTOP
  expect(listing.calls).toBe(0); // no real `ps`
  expect(killed).toEqual([LEADER]); // only the faked group reap
});

test("C-LIFE-10 the inert resume sends no real signal and lets go of the group", async () => {
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  const quiet = quietProcessTree();
  quiet.stopGroup(LEADER);
  quiet.continueGroup(LEADER);
  expect(await quiet.listProcesses(1_000)).toEqual([]);
  expect(kill).not.toHaveBeenCalled();
});
