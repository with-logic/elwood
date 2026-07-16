/**
 * Wires a ClaudeSession's primitives into the `/login` driver (PRD §5.3,
 * C-API-43). Runs the flow as an EXCLUSIVE control-queue task: a fresh-`ready`
 * watch is armed up front so `awaitUsable` resolves only on a post-start `ready`
 * transition (renewed usability, not a stale banner), `/login` and all interactive
 * keystrokes are written directly (the lease already owns the queue), and the task
 * aborts when the session closes. Kept out of the session file for the size cap.
 */

import type { ControlQueue } from "../../core/control-queue.ts";
import { commandEnterDelayMs } from "../../core/session-input.ts";
import type { ScreenTerminal } from "../../core/tui-screen.ts";
import { raceSettle } from "./abort.ts";
import { driveLogin } from "./driver.ts";
import type { ClaudeLoginOptions } from "./types.ts";

export type LoginSessionDeps = {
  readonly controlQueue: ControlQueue;
  readonly terminal: ScreenTerminal;
  /**
   * Subscribe to `ready` transitions. Returns an unsubscribe. Unlike a snapshot
   * wait this fires only on a FRESH transition, so `awaitUsable` cannot settle on
   * a stale pre-login `ready` — it must observe the session become usable again.
   */
  readonly onReady: (handler: () => void) => () => void;
};

export function runSessionLogin(
  deps: LoginSessionDeps,
  options: ClaudeLoginOptions,
): Promise<void> {
  return deps.controlQueue.runExclusive("login", async (signal) => {
    // Arm the fresh-`ready` watch UP FRONT (before `/login`), so a `ready` that
    // fires the instant success renders can never be missed by `awaitUsable`
    // subscribing too late. `freshReady` latches the first post-start transition.
    const freshReady = watchFreshReady(deps, signal);
    try {
      await driveLogin(
        {
          terminal: deps.terminal,
          submit: (command) => submitLoginCommand(deps, command),
          awaitUsable: (_timeoutMs, s) => raceSettle(freshReady.wait(), s),
        },
        options,
        signal,
      );
    } finally {
      freshReady.stop();
    }
  });
}

// Latch the FIRST `ready` transition after login starts (a fresh usability signal
// for THIS attempt). Armed before `/login` so `wait()` resolves even if the
// transition already fired by the time it is awaited.
function watchFreshReady(deps: LoginSessionDeps, signal: AbortSignal) {
  let fired = false;
  let notify: (() => void) | undefined;
  const off = deps.onReady(() => {
    fired = true;
    notify?.();
  });
  const stop = () => {
    off();
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  return {
    stop,
    wait: (): Promise<void> =>
      fired ? Promise.resolve() : new Promise<void>((resolve) => (notify = resolve)),
  };
}

// Write `/login` directly (the exclusive lease already owns the queue): the
// command text, a settle delay, then a single Enter — mirroring command mode.
async function submitLoginCommand(deps: LoginSessionDeps, command: string): Promise<void> {
  await deps.terminal.sendInput(command);
  await delay(commandEnterDelayMs);
  await deps.terminal.sendInput("\r");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
