/** A controlled PTY leader and process-table interleavings for graceful signals (C-LIFE-10). */
import { vi } from "vitest";
import type { PtyExit } from "../../src/pty/types.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { leaderRow } from "./scripted-process-tree.ts";

type LeaderGeneration = "original" | "replacement" | "gone";

const PID = 10_000_001;
const NEW_START = "Sun Oct 25 22:00:09 2026";
export function heldLeaderHarness(
  options: {
    readonly replaceAfterRead?: boolean;
    readonly replaceOnStop?: boolean;
    readonly goneOnStop?: boolean;
    readonly firstReadError?: Error;
    readonly postStopError?: Error;
    readonly stopError?: Error;
    readonly resumeError?: Error;
    readonly termError?: Error;
    readonly notStopped?: boolean;
    readonly elapsedBeforeStopMs?: number;
    readonly exitOnStop?: boolean;
    readonly exitAfterRead?: boolean;
    readonly zombieOnStop?: boolean;
    readonly differentGroup?: boolean;
    readonly elapsedAfterReadMs?: number;
  } = {},
) {
  let generation: LeaderGeneration = "original";
  let held = false;
  let reads = 0;
  let exit: ((event: PtyExit) => void) | undefined;
  const signals: { readonly generation: LeaderGeneration; readonly held: boolean }[] = [];
  const operations: string[] = [];
  const timeouts: number[] = [];
  let clock = 0;
  if (options.elapsedBeforeStopMs !== undefined || options.elapsedAfterReadMs !== undefined)
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  const ops = {
    killGroup: vi.fn(),
    stopGroup: () => {
      operations.push("stop");
      if (options.replaceOnStop) generation = "replacement";
      if (options.goneOnStop) generation = "gone";
      if (options.exitOnStop) exit?.({ exitCode: 0 });
      if (options.stopError) throw options.stopError;
      held = !options.notStopped;
    },
    continueGroup: () => {
      operations.push("continue");
      if (options.resumeError) throw options.resumeError;
      held = false;
    },
    listProcesses: (timeoutMs: number) => {
      reads += 1;
      operations.push("read");
      timeouts.push(timeoutMs);
      if (reads > 1 && options.exitAfterRead) queueMicrotask(() => exit?.({ exitCode: 0 }));
      const error = reads === 1 ? options.firstReadError : options.postStopError;
      if (error) return Promise.reject(error);
      const table =
        generation === "gone"
          ? []
          : [
              {
                ...leaderRow,
                pid: PID,
                pgid: options.differentGroup && held ? PID + 1 : PID,
                stopped: held,
                zombie: !!options.zombieOnStop && operations.includes("stop"),
                startedAt: generation === "replacement" ? NEW_START : leaderRow.startedAt,
              },
            ];
      table.unshift({
        ...leaderRow,
        pid: process.pid,
        pgid: process.pid,
        stopped: false,
        zombie: false,
      });
      if (reads === 1) {
        if (options.replaceAfterRead)
          queueMicrotask(() => {
            generation = "replacement";
          });
        clock = options.elapsedBeforeStopMs ?? 0;
      }
      if (reads > 1) {
        if (options.elapsedAfterReadMs !== undefined) clock = options.elapsedAfterReadMs;
      }
      return Promise.resolve(table);
    },
  };
  const pty = {
    pid: PID,
    onData: () => () => {},
    onExit: (handler: (event: PtyExit) => void) => {
      exit = handler;
      return () => {};
    },
    write: () => {},
    resize: () => "resized" as const,
    kill: () => {
      operations.push("TERM");
      signals.push({ generation, held });
      if (options.termError) throw options.termError;
      exit?.({ exitCode: 0 });
    },
  };
  const reaper = new SessionReaper(PID, ops);
  return {
    ops,
    signals,
    operations,
    timeouts,
    reaper,
    stop: () => terminatePty(pty, "SIGTERM", reaper),
  };
}
