/**
 * Failed-start test helpers (PRD §9.1, C-LIFE-10, C-ERR-08): a fake CLI that exits
 * during startup, a running one whose startup output makes the start fail, a group
 * killer that refuses every kill, and a reader for the typed rejection.
 */

import { ElwoodError } from "../../src/core/errors.ts";
import type { PtySpawnOptions } from "../../src/pty/types.ts";
import { setProcessTreeOpsForTests } from "../../src/runtime/shutdown/reap-tree.ts";
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

/** Makes every group kill fail with `EPERM` (an injected fake; nothing is signaled). */
export function refuseGroupKills(): void {
  setProcessTreeOpsForTests({
    killGroup: () => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    },
  });
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

/**
 * A fake CLI that exits with `exitCode` during startup and writes `late` only once the
 * session's terminal has stopped reading it: a PTY's last output can arrive after its exit
 * (PRD §9.4). Its `onData` unsubscribes for real, so the late write reaches only the
 * listeners still attached.
 */
export function exitingBeforeLateOutput(ptys: FakePty[], exitCode: number, late: string): Factory {
  return (options) => {
    const pty = new FakePty(options, 1000 + ptys.length);
    ptys.push(pty);
    pty.onData = (handler) => {
      pty.dataHandlers.push(handler);
      return () => {
        const at = pty.dataHandlers.indexOf(handler);
        if (at >= 0) pty.dataHandlers.splice(at, 1);
      };
    };
    let listening = 0;
    const deadline = Date.now() + EXIT_LISTENER_WAIT_MS;
    const timer = setInterval(() => {
      if (listening === 0 && pty.exitHandlers.length > 0) {
        listening = pty.dataHandlers.length;
        pty.emitExit({ exitCode });
        return;
      } else if (listening > 0 && pty.dataHandlers.length < listening) {
        pty.emitData(late); // the terminal has let go of the PTY
      } else if (Date.now() < deadline) return;
      clearInterval(timer);
    }, 0);
    timer.unref();
    return pty;
  };
}
