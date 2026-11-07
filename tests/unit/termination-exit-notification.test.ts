/** Group disappearance never substitutes for native PTY exit (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { gracefulTermination } from "../helpers/graceful-termination.ts";
import { leaderRow, scripted, useScriptedHost } from "../helpers/scripted-process-tree.ts";

useScriptedHost();
afterEach(() => vi.useRealTimers());
const bounds = { gracefulMs: 20, forceMs: 20 };

test.each([
  "SIGTERM",
  "SIGKILL",
] as const)("C-LIFE-10 %s with a gone group waits for delayed native exit without more signals", async (signal) => {
  vi.useFakeTimers();
  const fake = scripted([[leaderRow]]);
  const fixture = gracefulTermination(fake.ops);
  fixture.reaper.reap();
  const completed = [...fake.calls];
  let settled = false;
  const pending = terminatePty(fixture.pty, signal, fixture.reaper, bounds).then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  fixture.exit();
  await pending;
  expect(settled).toBe(true);
  expect(fixture.ptySignals).toEqual([]);
  expect(fake.calls).toEqual(completed);
});

test.each([
  "SIGTERM",
  "SIGKILL",
] as const)("C-LIFE-10 %s with a gone group rejects when native exit never arrives", async (signal) => {
  vi.useFakeTimers();
  const fake = scripted([[leaderRow]]);
  const fixture = gracefulTermination(fake.ops);
  fixture.reaper.reap();
  const completed = [...fake.calls];
  const pending = terminatePty(fixture.pty, signal, fixture.reaper, bounds).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(40);
  expect(await pending).toMatchObject({
    code: "termination_failed",
    message: "PTY did not exit after SIGKILL.",
  });
  expect(fixture.ptySignals).toEqual([]);
  expect(fake.calls).toEqual(completed);
});
