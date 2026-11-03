/** A confirmed-gone group never authorizes later numeric signals (C-LIFE-10). */
import { expect, test, vi } from "vitest";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { errno, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

const timeouts = { gracefulMs: 0, forceMs: 0 };
const pty = (kill: () => void) => ({
  pid: LEADER,
  onData: () => () => {},
  onExit: () => () => {},
  write: () => {},
  resize: () => "resized" as const,
  kill,
});

test.each([
  "ESRCH",
  "EPERM empty",
  "EPERM zombies",
])("C-LIFE-10 %s permanently cancels later PTY and group signals", async (kind) => {
  const rows = kind === "EPERM zombies" ? [{ ...leaderRow, zombie: true }] : [];
  const stop = vi.fn(() => {
    throw errno(kind === "ESRCH" ? "ESRCH" : "EPERM");
  });
  const fake = scripted([rows], { stopGroup: stop });
  const reaper = new SessionReaper(LEADER, fake.ops);
  const send = vi.fn();
  await expect(terminatePty(pty(send), "SIGKILL", reaper, timeouts)).resolves.toBeUndefined();
  for (const signal of ["SIGTERM", "SIGKILL"] as const)
    await expect(terminatePty(pty(send), signal, reaper, timeouts)).resolves.toBeUndefined();
  await reaper.sweepDetached(() => false);
  reaper.reap();
  reaper.reapAndThrowOnDetachedSweepFailure();
  expect(send).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledOnce();
  expect(fake.calls.filter((call) => call.startsWith("kill"))).toEqual([]);
});

test("C-LIFE-10 confirmed group exit does not clear an earlier unresolved descendant failure", async () => {
  let code = "EIO";
  const fake = scripted([], {
    stopGroup: () => {
      throw errno(code);
    },
  });
  const reaper = new SessionReaper(LEADER, fake.ops);
  await expect(reaper.sweepDetached(() => false)).rejects.toThrow(
    "could not stop the leader's group",
  );
  code = "ESRCH";
  const send = vi.fn();
  await expect(terminatePty(pty(send), "SIGKILL", reaper, timeouts)).rejects.toMatchObject({
    code: "termination_failed",
    details: { cause: expect.stringContaining("could not stop the leader's group") },
  });
  expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).toThrow(
    "could not stop the leader's group",
  );
  expect(send).not.toHaveBeenCalled();
  expect(fake.calls).toEqual([]);
});

test("C-LIFE-10 a queued sweep rechecks group-gone evidence before dispatch", async () => {
  const held = Promise.withResolvers<readonly ProcessEntry[]>();
  const stop = vi.fn(() => {
    throw errno("EPERM");
  });
  const fake = scripted([], { stopGroup: stop, listProcesses: () => held.promise });
  const reaper = new SessionReaper(LEADER, fake.ops);
  const first = reaper.sweepDetached(() => false);
  const second = reaper.sweepDetached(() => false);
  expect(stop).toHaveBeenCalledOnce();
  held.resolve([]);
  await Promise.all([first, second]);
  expect(stop).toHaveBeenCalledOnce();
  reaper.reap();
  expect(fake.calls).toEqual([]);
});
