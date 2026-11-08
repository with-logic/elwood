/** Group disappearance never substitutes for native PTY exit (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import type { PtyExit, PtyProcess } from "../../src/pty/types.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { errno, LEADER, scripted, useScriptedHost } from "../helpers/scripted-process-tree.ts";

useScriptedHost();
afterEach(() => vi.useRealTimers());
const bounds = { gracefulMs: 20, forceMs: 20 };

async function goneGroup() {
  const fake = scripted([], {
    stopGroup: () => {
      throw errno("ESRCH");
    },
  });
  const reaper = new SessionReaper(LEADER, fake.ops);
  await reaper.sweepDetached(() => false);
  let onExit: ((exit: PtyExit) => void) | undefined;
  const kill = vi.fn();
  const pty: PtyProcess = {
    pid: LEADER,
    onData: () => () => {},
    onExit: (handler) => {
      onExit = handler;
      return () => {};
    },
    write: () => {},
    resize: () => "resized",
    kill,
  };
  return { pty, reaper, kill, calls: fake.calls, exit: () => onExit?.({ exitCode: 0 }) };
}

test.each([
  "SIGTERM",
  "SIGKILL",
] as const)("C-LIFE-10 %s with a gone group waits for delayed native exit without more signals", async (signal) => {
  vi.useFakeTimers();
  const fixture = await goneGroup();
  let settled = false;
  const pending = terminatePty(fixture.pty, signal, fixture.reaper, bounds).then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  fixture.exit();
  await pending;
  expect(settled).toBe(true);
  expect(fixture.kill).not.toHaveBeenCalled();
  expect(fixture.calls).toEqual([]);
});

test.each([
  "SIGTERM",
  "SIGKILL",
] as const)("C-LIFE-10 %s with a gone group rejects when native exit never arrives", async (signal) => {
  vi.useFakeTimers();
  const fixture = await goneGroup();
  const pending = terminatePty(fixture.pty, signal, fixture.reaper, bounds).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(bounds.gracefulMs + bounds.forceMs);
  expect(await pending).toMatchObject({
    code: "termination_failed",
    message: "PTY exit was not observed within the termination window.",
  });
  expect(fixture.kill).not.toHaveBeenCalled();
  expect(fixture.calls).toEqual([]);
});
