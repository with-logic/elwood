/** Independent safe groups and explicit confirmations survive blocked recovery (C-LIFE-14). */
import { afterEach, expect, test, vi } from "vitest";
import { SessionReapPolicy } from "../../src/runtime/session/reap.ts";
import {
  BACKGROUND_REAP_LIFETIME_MS,
  reapInBackground,
} from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import {
  resetProcessTreeOpsForTests,
  setProcessTreeOpsForTests,
} from "../../src/runtime/shutdown/process-tree-ops.ts";
import { errno, hook, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

afterEach(() => {
  vi.useRealTimers();
  resetProcessTreeOpsForTests();
});

test.each([
  false,
  true,
])("C-LIFE-14 ambiguity is per group (same group=%s), while daemon-resume debt recovers", async (sameGroup) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T22:00:00.500Z"));
  const old = "Sun Oct 25 21:59:00 2026";
  const ambiguous = hook(5002);
  const safe = hook(5003, { startedAt: old, pgid: sameGroup ? 5002 : 5003 });
  const daemon = hook(5004, { startedAt: old, shared: true, stopped: true });
  const record = new DescendantRecord();
  record.observe([leaderRow, ambiguous, safe, { ...daemon, shared: false }], LEADER);
  record.resumes.remember([daemon], 5004);
  const fake = scripted([]);
  const killed = new Set<number>();
  const ops = {
    ...fake.ops,
    listProcesses: () =>
      Promise.resolve(
        fake.asRead([ambiguous, safe, daemon].filter((row) => !killed.has(row.pgid))),
      ),
    killGroup: (group: number) => {
      fake.ops.killGroup(group);
      killed.add(group);
    },
  };
  const recovery = reapInBackground(record, ops);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(fake.calls).toContain("cont 5004");
  if (sameGroup) expect(fake.calls).not.toContain("kill 5002");
  else expect(fake.calls).toContain("kill 5003");
  expect(fake.calls).not.toContain("stop 5002");
  expect(recovery.resolved()).toBe(false);
});

test("C-LIFE-14 an unparseable matching live identity is never stopped or killed", async () => {
  vi.useFakeTimers();
  const row = hook(5002, { startedAt: "unparseable" });
  const record = new DescendantRecord();
  record.observe([leaderRow, row], LEADER);
  const fake = scripted([[row]]);
  const recovery = reapInBackground(record, fake.ops);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(fake.calls.filter((call) => call !== "list")).toEqual([]);
  expect(recovery.resolved()).toBe(false);
});

test("C-LIFE-14 explicit confirmation after the automatic window observes a survivor's later exit", async () => {
  vi.useFakeTimers();
  const row = hook(5002);
  const record = new DescendantRecord();
  record.observe([leaderRow, row], LEADER);
  let alive = true;
  let unreadable = false;
  const fake = scripted([], {
    listProcesses: () =>
      unreadable ? Promise.reject(errno("EIO")) : Promise.resolve(alive ? [row] : []),
    stopGroup: () => {
      throw errno("EPERM");
    },
  });
  const recovery = reapInBackground(record, fake.ops);
  await vi.advanceTimersByTimeAsync(BACKGROUND_REAP_LIFETIME_MS);
  expect(recovery.resolved()).toBe(false);
  alive = false;
  unreadable = true;
  await recovery.confirm();
  expect(recovery.resolved()).toBe(false);
  unreadable = false;
  await Promise.all([recovery.confirm(), recovery.confirm()]);
  expect(recovery.resolved()).toBe(true);
  expect(fake.calls.filter((call) => call.startsWith("kill"))).toEqual([]);
});

test("C-LIFE-14 a later explicit shutdown confirms expired recovery without re-signaling its leader", async () => {
  vi.useFakeTimers();
  let reads = 0;
  let gone = false;
  const fake = scripted([], {
    stopGroup: (group) => {
      if (group !== LEADER) throw errno("EPERM");
    },
  });
  setProcessTreeOpsForTests({
    ...fake.ops,
    listProcesses: () => {
      reads += 1;
      if (reads === 2) return Promise.reject(errno("EIO"));
      return Promise.resolve(
        fake.asRead(reads === 1 ? [leaderRow, hook(5002)] : gone ? [] : [hook(5002, { ppid: 1 })]),
      );
    },
  });
  const policy = new SessionReapPolicy("codex", "test", LEADER);
  await expect(policy.reaper.sweepDetached(() => false)).rejects.toThrow(
    "process table unreadable",
  );
  expect(() => policy.orThrow()).toThrow("Could not confirm");
  await vi.advanceTimersByTimeAsync(BACKGROUND_REAP_LIFETIME_MS);
  await expect(Promise.resolve().then(() => policy.orThrow())).rejects.toMatchObject({
    code: "termination_failed",
  });
  gone = true;
  await expect(Promise.resolve().then(() => policy.orThrow())).resolves.toBeUndefined();
  expect(fake.calls.filter((call) => call === `kill ${LEADER}`)).toHaveLength(1);
});

test.each([
  true,
  false,
])("C-LIFE-14 a resume-only recovery resolves only for a known tree (%s)", async (known) => {
  vi.useFakeTimers();
  const record = new DescendantRecord();
  if (known) record.observe([leaderRow], LEADER, true);
  record.resumes.remember([{ ...leaderRow, stopped: true }], LEADER);
  const { ops, calls } = scripted([[{ ...leaderRow, stopped: true }]]);
  const recovery = reapInBackground(record, ops);
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toContain(`cont ${LEADER}`);
  expect(recovery.resolved()).toBe(known);
});

test("C-LIFE-14 all retries retain the same daemon-path cache while refreshing the table", async () => {
  vi.useFakeTimers();
  const row = hook(5002);
  const record = new DescendantRecord();
  record.observe([leaderRow, row], LEADER);
  const scopes: (Set<string> | undefined)[] = [];
  const fake = scripted([], {
    stopGroup: () => {
      throw errno("EPERM");
    },
  });
  const recovery = reapInBackground(record, {
    ...fake.ops,
    listProcesses: (_ms, scope) => {
      scopes.push(scope?.known);
      scope?.known.add("confirmed daemon path");
      return Promise.resolve([row]);
    },
  });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(scopes.length).toBeGreaterThan(3);
  for (const known of scopes) {
    expect(known).toBe(scopes[0]);
    expect(known?.has("confirmed daemon path")).toBe(true);
  }
  expect(recovery.resolved()).toBe(false);
});
