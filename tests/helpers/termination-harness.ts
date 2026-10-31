/**
 * A scripted PTY and session reaper for the `terminatePty` tests (PRD §5.3 and §9.4,
 * C-LIFE-10): the fake leader exits on the signals a script names, or during the sweep
 * or the survivor watch's first read, and every signal, sweep, watch step, and reap is
 * logged. No real process is signaled.
 */

import type { PtyExit, PtyProcess } from "../../src/pty/types.ts";
import {
  type FailureReason,
  SweepFailures,
} from "../../src/runtime/shutdown/detached-sweep/failures.ts";
import type { terminatePty } from "../../src/runtime/shutdown/terminate.ts";

export const timeouts = { gracefulMs: 20, forceMs: 20 };

/** A failure in the sweep's own shape, so a field the reporter reads is the real one. */
export function sweepFailure(reason: FailureReason, ids: readonly number[], code?: string): Error {
  const failures = new SweepFailures();
  failures.record(reason, code === undefined ? undefined : { code }, ids);
  return failures.result() as Error;
}
type Signal = Parameters<typeof terminatePty>[1];

type Script = {
  /** Which signals make the fake leader exit. */
  readonly exitsOn?: readonly Signal[];
  /** Exit while the sweep is in progress (models a leader dying mid-sweep). */
  readonly exitDuringSweep?: boolean;
  /** Exit while the survivor watch's first read is in progress, before any signal. */
  readonly exitDuringFirstRead?: boolean;
  readonly sweepError?: unknown;
  readonly survivorError?: unknown;
  readonly killError?: Error;
};

export function harness(script: Script) {
  const calls: string[] = [];
  let onExit: ((exit: PtyExit) => void) | undefined;
  const pty: PtyProcess = {
    pid: 4242,
    onData: () => () => {},
    onExit: (handler) => {
      onExit = handler;
      return () => void calls.push("unsubscribe");
    },
    write: () => {},
    resize: () => "resized",
    kill: (signal) => {
      calls.push(`signal ${signal}`);
      if (script.killError) throw script.killError;
      if (script.exitsOn?.some((exitSignal) => exitSignal === signal))
        queueMicrotask(() => onExit?.({ exitCode: 0 }));
    },
  };
  const reaper = {
    reap: () => void calls.push("reap"),
    sweepDetached: (leaderExited: () => boolean) => {
      calls.push(`sweep (exited: ${leaderExited()})`);
      if (script.exitDuringSweep) onExit?.({ exitCode: 0 });
      calls.push(`swept (exited: ${leaderExited()})`);
      return script.sweepError === undefined
        ? Promise.resolve()
        : Promise.reject(script.sweepError);
    },
    watchSurvivors: (leaderExited: () => boolean) => {
      calls.push("watch");
      return {
        firstRead: Promise.resolve().then(() => {
          calls.push("first read");
          if (script.exitDuringFirstRead) onExit?.({ exitCode: 0 });
          return false;
        }),
        sendSignal: (send: () => void) => {
          send();
          return Promise.resolve(false);
        },
        finish: () => {
          calls.push(`survivors (leader gone: ${leaderExited()})`);
          const error = script.survivorError;
          return error === undefined ? Promise.resolve() : Promise.reject(error);
        },
      };
    },
  };
  return { pty, reaper, calls };
}

export const swept = ["sweep (exited: false)", "swept (exited: false)"];
export const watched = ["watch", "first read", "signal SIGTERM"];
