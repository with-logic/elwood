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
import { abortError, deadlineSignal, holdWhileBlocked, raceSettle } from "./abort.ts";
import { driveLogin } from "./driver.ts";
import { type ClaudeLoginOptions, defaultLoginTimeoutMs } from "./types.ts";

const escapeKey = "\u001b";

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
  // Start the OVERALL deadline NOW — before the queue dispatches the exclusive
  // task — so `timeoutMs` bounds the whole call including any time spent WAITING
  // behind other queued operations, honoring the `login_timeout after timeoutMs`
  // contract regardless of queue depth.
  const timeoutMs = options.timeoutMs ?? defaultLoginTimeoutMs;
  const controller = new AbortController();
  const deadline = deadlineSignal(timeoutMs, controller.signal);
  return deps.controlQueue
    .runExclusive(
      "login",
      async (queueClose) => {
        // Compose the pre-started deadline with the queue's close signal so the flow
        // settles on the FIRST of timeout, session close, success, or failure.
        queueClose.addEventListener("abort", () => controller.abort(), { once: true });
        const readies = watchReadyCount(deps, deadline.signal);
        try {
          await driveLogin(
            {
              terminal: deps.terminal,
              blocked: deps.blocked,
              submit: (command) => submitLoginCommand(deps, command, deadline.signal),
              awaitUsable: () => raceSettle(readies.waitForNext(), deadline.signal),
            },
            options,
            deadline.signal,
          );
        } catch (error) {
          // Best-effort: cancel the still-open login UI before releasing the lease,
          // so a failed/timed-out attempt leaves no dialog for the next queued op to
          // write into. Never masks the original error.
          try {
            await deps.terminal.sendInput(escapeKey);
          } catch {
            // A closed terminal makes the cancel a no-op; the original error stands.
          }
          throw error;
        } finally {
          readies.stop();
        }
      },
      // Drop this login if its deadline fires while it is STILL QUEUED behind other
      // work, so the timeout bounds queue-wait too.
      { signal: deadline.signal, error: () => abortError(deadline.signal) },
    )
    .finally(() => deadline.cancel());
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
