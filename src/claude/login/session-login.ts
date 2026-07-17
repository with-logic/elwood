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
import { holdWhileBlocked, raceSettle } from "./abort.ts";
import { driveLogin } from "./driver.ts";
import type { ClaudeLoginOptions } from "./types.ts";

export type LoginSessionDeps = {
  readonly controlQueue: ControlQueue;
  readonly terminal: ScreenTerminal;
  /** Whether a blocking dialog is on screen (login writes hold while true). */
  readonly blocked: () => boolean;
  /**
   * Subscribe to `ready` transitions. Returns an unsubscribe. Fires on a fresh
   * transition, so `awaitUsable` observes the session become usable AFTER auth.
   */
  readonly onReady: (handler: () => void) => () => void;
};

export function runSessionLogin(
  deps: LoginSessionDeps,
  options: ClaudeLoginOptions,
): Promise<void> {
  return deps.controlQueue.runExclusive("login", async (signal) => {
    // Watch `ready` transitions from the start of the transaction. `awaitUsable`,
    // called right after success is detected, waits for the NEXT ready — so only a
    // transition that follows successful auth proves renewed usability; a ready
    // seen earlier in the flow (e.g. a stale pre-login one) never counts.
    const readies = watchReadyCount(deps, signal);
    try {
      await driveLogin(
        {
          terminal: deps.terminal,
          blocked: deps.blocked,
          submit: (command) => submitLoginCommand(deps, command, signal),
          awaitUsable: (_timeoutMs, s) => raceSettle(readies.waitForNext(), s),
        },
        options,
        signal,
      );
    } finally {
      readies.stop();
    }
  });
}

// Track a monotonic count of `ready` transitions since login started, and let a
// caller wait for the NEXT ready strictly after the count it captures — so a ready
// observed before success is never mistaken for post-auth usability.
function watchReadyCount(deps: LoginSessionDeps, signal: AbortSignal) {
  let count = 0;
  const waiters = new Set<() => void>();
  const off = deps.onReady(() => {
    count += 1;
    for (const w of waiters) w();
    waiters.clear();
  });
  const stop = () => {
    off();
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  return {
    stop,
    // Resolve on the NEXT ready strictly after this call (post-success). A ready
    // that already fired earlier in the flow does not satisfy it.
    waitForNext: (): Promise<void> => {
      const baseline = count;
      return new Promise<void>((resolve) => {
        const check = () => (count > baseline ? resolve() : waiters.add(check));
        check();
      });
    },
  };
}

// Write `/login` directly (the exclusive lease already owns the queue): hold while
// a dialog blocks, then the command text, a settle delay, then a single Enter —
// mirroring command mode. Every step races the signal so a mid-submission
// close/timeout settles promptly instead of writing into a dead terminal.
async function submitLoginCommand(
  deps: LoginSessionDeps,
  command: string,
  signal: AbortSignal,
): Promise<void> {
  await holdWhileBlocked(deps.blocked, signal);
  await raceSettle(Promise.resolve(deps.terminal.sendInput(command)), signal);
  await raceSettle(delay(commandEnterDelayMs), signal);
  await raceSettle(Promise.resolve(deps.terminal.sendInput("\r")), signal);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
