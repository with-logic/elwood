/** Public graceful termination retains original authority through exit and force (C-LIFE-10). */
import { expect, test } from "vitest";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { gracefulTermination } from "../helpers/graceful-termination.ts";
import {
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();
const bounds = { gracefulMs: 0, forceMs: 0 };

test("C-LIFE-10 native exit and final cleanup never kill a replacement leader group", async () => {
  const child = hook(5002);
  const replacement = { ...leaderRow, startedAt: "Sun Oct 25 22:00:09 2026" };
  const fake = scripted([]);
  const fixture = gracefulTermination({
    ...fake.ops,
    listProcesses: () =>
      Promise.resolve(
        fake.asRead(fixture.exited() ? [replacement, { ...child, ppid: 1 }] : [leaderRow, child]),
      ),
  });
  let exitCallbacks = 0;
  fixture.pty.onExit(() => {
    exitCallbacks += 1;
    fixture.reaper.reap();
  });
  await expect(terminatePty(fixture.pty, "SIGTERM", fixture.reaper, bounds)).rejects.toMatchObject({
    code: "termination_failed",
    details: {
      cause: expect.stringContaining("a survivor group has an ambiguous identity"),
      unconfirmedProcessGroupIds: [LEADER],
    },
  });
  expect(exitCallbacks).toBe(1);
  expect(fake.calls).toContain("kill 5002");
  expect(fake.calls).not.toContain(`kill ${LEADER}`);
  const completed = [...fake.calls];
  for (const signal of ["SIGTERM", "SIGKILL"] as const)
    await expect(terminatePty(fixture.pty, signal, fixture.reaper, bounds)).rejects.toMatchObject({
      code: "termination_failed",
      details: { unconfirmedProcessGroupIds: [LEADER] },
    });
  expect(fake.calls).toEqual(completed);
  expect(fixture.ptySignals).toEqual(["SIGTERM"]);
});

test("C-LIFE-10 ignored TERM exits through a verified original group kill", async () => {
  const fake = scripted([[leaderRow]]);
  const fixture = gracefulTermination({
    ...fake.ops,
    killGroup: (pid) => {
      fake.calls.push(`kill ${pid}`);
      if (pid === LEADER) fixture.exit();
    },
  });
  fixture.pty.kill = (signal = "SIGTERM") => {
    fixture.ptySignals.push(signal);
  };
  await terminatePty(fixture.pty, "SIGTERM", fixture.reaper, bounds);
  expect(fake.calls).toContain(`kill ${LEADER}`);
  expect(fixture.exited()).toBe(true);
  expect(fixture.ptySignals).toEqual(["SIGTERM"]);
});
