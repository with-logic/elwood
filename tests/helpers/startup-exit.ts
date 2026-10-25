/**
 * Failed-start test helpers (PRD §9.1, C-LIFE-10): a fake CLI that exits during
 * startup, a running one whose startup output makes the start fail, and a reader for
 * the typed rejection.
 */

import { ElwoodError } from "../../src/core/errors.ts";
import type { PtySpawnOptions } from "../../src/pty/types.ts";
import { FakePty } from "./fake-pty.ts";

export const startupExit = { exitCode: 12, signal: 15 } as const;

type Factory = (options: PtySpawnOptions) => FakePty;

// How long the fake CLI waits for the session to listen for its exit before giving up.
const EXIT_LISTENER_WAIT_MS = 10_000;

/** A fake CLI that exits during startup, as soon as the session listens for its exit. */
export function exitingDuringStartup(ptys: FakePty[]): Factory {
  return (options) => {
    const pty = new FakePty(options, 1000 + ptys.length);
    ptys.push(pty);
    const deadline = Date.now() + EXIT_LISTENER_WAIT_MS;
    const timer = setInterval(() => {
      if (pty.exitHandlers.length > 0) pty.emitExit(startupExit);
      else if (Date.now() < deadline) return;
      clearInterval(timer); // Exited, or the start failed before anything listened.
    }, 0);
    timer.unref();
    return pty;
  };
}

/** A fake CLI that keeps running but prints `output` during startup. */
export function runningWithStartupOutput(ptys: FakePty[], output: string): Factory {
  return (options) => {
    const pty = new FakePty(options, 1000 + ptys.length);
    ptys.push(pty);
    queueMicrotask(() => pty.emitData(output));
    return pty;
  };
}

/** Resolves to the typed error `launch` rejected with; anything else fails the test. */
export async function rejection(
  launch: Promise<{ readonly teardown: () => Promise<void> }>,
): Promise<ElwoodError> {
  const outcome = await launch.then(
    async (session) => {
      await session.teardown();
      return new Error("the launch started");
    },
    (error: unknown) => error,
  );
  if (outcome instanceof ElwoodError) return outcome;
  throw outcome; // An untyped rejection or a started launch fails the test with itself.
}
