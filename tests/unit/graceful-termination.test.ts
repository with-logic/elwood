/** Graceful shutdown activates identity-bound recording before TERM (C-LIFE-10). */
import { expect, test } from "vitest";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { gracefulTermination } from "../helpers/graceful-termination.ts";
import {
  errno,
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();
const bounds = { gracefulMs: 0, forceMs: 0 };

test("C-LIFE-10 successful TERM reaps a recorded helper after the leader exits", async () => {
  const child = hook(5002);
  const order: string[] = [];
  const fake = scripted([]);
  const fixture = gracefulTermination({
    ...fake.ops,
    listProcesses: () =>
      Promise.resolve(fake.asRead(fixture.exited() ? [{ ...child, ppid: 1 }] : [leaderRow, child])),
    killGroup: (group) => {
      fake.calls.push(`kill ${group}`);
      if (group === child.pgid) order.push("helper KILL");
    },
  });
  fixture.pty.onExit(() => order.push("exit"));
  const kill = fixture.pty.kill;
  fixture.pty.kill = (signal = "SIGTERM") => {
    order.push(signal);
    kill(signal);
  };
  await terminatePty(fixture.pty, "SIGTERM", fixture.reaper, bounds);
  expect(order).toEqual(["SIGTERM", "exit", "helper KILL"]);
  expect(fixture.ptySignals).toEqual(["SIGTERM"]);
  expect(fake.calls).toContain("kill 5002");
  expect(fake.calls).not.toContain(`cont ${LEADER}`);
  expect(fake.calls).not.toContain(`kill ${LEADER}`);
});

test("C-LIFE-10 a failed first read forbids TERM and final or later group signals", async () => {
  const fake = scripted([], { listProcesses: () => Promise.reject(errno("EIO")) });
  const fixture = gracefulTermination(fake.ops);
  await expect(terminatePty(fixture.pty, "SIGTERM", fixture.reaper, bounds)).rejects.toMatchObject({
    code: "termination_failed",
    details: { errno: "EIO" },
  });
  expect(fixture.ptySignals).toEqual([]);
  expect(fake.calls).toEqual([]);
  expect(() => fixture.reaper.reap()).toThrow("First leader process-table read failed");
  expect(() => fixture.reaper.signalLeaderPty(() => fixture.pty.kill())).toThrow();
  expect(fixture.ptySignals).toEqual([]);
  await expect(fixture.reaper.sweepDetached(() => false)).rejects.toThrow();
  expect(fake.calls).toEqual([]);
});

test("C-LIFE-10 replacement ownership receives no TERM, CONT or final reap", async () => {
  const fake = scripted([[leaderRow], [{ ...leaderRow, startedAt: "Sun Oct 25 22:00:09 2026" }]]);
  const fixture = gracefulTermination(fake.ops);
  await expect(terminatePty(fixture.pty, "SIGTERM", fixture.reaper, bounds)).rejects.toThrow(
    "not confirmed held",
  );
  expect(fixture.ptySignals).toEqual([]);
  expect(fake.calls).not.toContain(`kill ${LEADER}`);
  expect(fake.calls).not.toContain(`cont ${LEADER}`);
});

test("C-LIFE-10 native exit during the first read cannot bypass the graceful ownership veto", async () => {
  const first = Promise.withResolvers<readonly ProcessEntry[]>();
  const fake = scripted([], { listProcesses: () => first.promise });
  const fixture = gracefulTermination(fake.ops);
  fixture.pty.onExit(() => {
    try {
      fixture.reaper.reap();
    } catch {
      /* Native session exit contains reap failures. */
    }
  });
  const pending = terminatePty(fixture.pty, "SIGTERM", fixture.reaper, bounds).then(
    () => undefined,
    (error: unknown) => error,
  );
  fixture.exit();
  first.resolve([]);
  expect(await pending).toMatchObject({ code: "termination_failed" });
  expect(fixture.ptySignals).toEqual([]);
  expect(fake.calls).toEqual([]);
});

test("C-LIFE-10 a completed group reap suppresses later graceful and force signals", async () => {
  const fake = scripted([[leaderRow]]);
  const fixture = gracefulTermination(fake.ops);
  fixture.reaper.reap();
  const completed = [...fake.calls];
  await terminatePty(fixture.pty, "SIGTERM", fixture.reaper, bounds);
  await fixture.reaper.sweepDetached(() => false);
  expect(fixture.reaper.signalLeaderPty(() => fixture.pty.kill())).toBe("leader-group-gone");
  expect(fixture.ptySignals).toEqual([]);
  expect(fake.calls).toEqual(completed);
});

test("C-LIFE-10 graceful ESRCH cancels every later leader signal", async () => {
  const fake = scripted([[leaderRow], []], {
    stopGroup: () => {
      throw errno("ESRCH");
    },
  });
  const fixture = gracefulTermination(fake.ops);
  await terminatePty(fixture.pty, "SIGTERM", fixture.reaper, bounds);
  await terminatePty(fixture.pty, "SIGTERM", fixture.reaper, bounds);
  expect(fixture.ptySignals).toEqual([]);
  expect(fake.calls).toEqual(["list", "list"]);
});

test("C-LIFE-10 recording continues after TERM and retains a newly observed helper", async () => {
  let term = false;
  const child = hook(5003);
  const fake = scripted([]);
  const fixture = gracefulTermination({
    ...fake.ops,
    listProcesses: (_timeout, scope) => {
      const rows = fixture.exited()
        ? [{ ...child, ppid: 1 }]
        : term
          ? [leaderRow, child]
          : [leaderRow];
      if (scope !== undefined && term && !fixture.exited()) queueMicrotask(fixture.exit);
      return Promise.resolve(fake.asRead(rows));
    },
  });
  fixture.pty.kill = (signal = "SIGTERM") => {
    fixture.ptySignals.push(signal);
    term = true;
  };
  await terminatePty(fixture.pty, "SIGTERM", fixture.reaper, { gracefulMs: 1_000, forceMs: 0 });
  expect(fixture.ptySignals).toEqual(["SIGTERM"]);
  expect(fake.calls).toContain("kill 5003");
});

test("C-LIFE-10 completed watches retain sweep errors when exit skips signaling", async () => {
  const fake = scripted([], { listProcesses: () => Promise.reject(errno("EIO")) });
  const fixture = gracefulTermination(fake.ops);
  await expect(fixture.reaper.sweepDetached(() => false)).rejects.toThrow();
  fixture.reaper.reap();
  const subscribe = fixture.pty.onExit;
  fixture.pty.onExit = (handler) => {
    queueMicrotask(fixture.exit);
    return subscribe(handler);
  };
  await expect(terminatePty(fixture.pty, "SIGTERM", fixture.reaper, bounds)).rejects.toMatchObject({
    code: "termination_failed",
    details: { errno: "EIO" },
  });
  expect(fixture.ptySignals).toEqual([]);
});

test("C-LIFE-10 failed held verification still reaps recorded helpers before native exit", async () => {
  const child = hook(5002);
  const replacement = { ...leaderRow, startedAt: "Sun Oct 25 22:00:09 2026" };
  const fake = scripted([
    [leaderRow, child],
    [replacement, { ...child, ppid: 1 }],
  ]);
  const fixture = gracefulTermination(fake.ops);
  await expect(terminatePty(fixture.pty, "SIGTERM", fixture.reaper, bounds)).rejects.toMatchObject({
    code: "termination_failed",
  });
  expect(fake.calls).toContain("kill 5002");
  expect(fake.calls).not.toContain(`kill ${LEADER}`);
  expect(fixture.ptySignals).toEqual([]);
  expect(fixture.exited()).toBe(false);
  fixture.exit();
});
