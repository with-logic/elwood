/** Actual termination/reaper boundary with injected process operations (C-LIFE-10). */
import type { PtyExit, PtyProcess } from "../../src/pty/types.ts";
import type { ProcessTreeOps } from "../../src/runtime/shutdown/process-tree-ops.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { LEADER } from "./scripted-process-tree.ts";

export function gracefulTermination(ops: ProcessTreeOps) {
  const handlers = new Set<(event: PtyExit) => void>();
  const signals: string[] = [];
  let exited = false;
  const exit = () => {
    exited = true;
    for (const handler of handlers) handler({ exitCode: 0 });
  };
  const pty: PtyProcess = {
    pid: LEADER,
    onData: () => () => {},
    onExit: (handler) => {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    write: () => {},
    resize: () => "resized",
    kill: (signal = "SIGTERM") => {
      signals.push(signal);
      exit();
    },
  };
  return { pty, signals, exit, exited: () => exited, reaper: new SessionReaper(LEADER, ops) };
}
