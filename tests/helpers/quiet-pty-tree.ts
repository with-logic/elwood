/** Inert process tables that include the live fake PTYs of an adapter harness (C-LIFE-10). */
import type { PtyProcess } from "../../src/pty/types.ts";
import { UNREAD } from "../../src/runtime/shutdown/process-table.ts";
import { quietProcessTree } from "../../src/runtime/shutdown/reap-tree.ts";

/** Keeps the harness's mutable PTY registry, read afresh at each process-table request. */
export function quietPtyTree(ptys: readonly Pick<PtyProcess, "pid">[]) {
  const quiet = quietProcessTree();
  return {
    ...quiet,
    listProcesses: async (...args: Parameters<typeof quiet.listProcesses>) => {
      const stopped = await quiet.listProcesses(...args);
      const seen = new Set(stopped.map((row) => row.pid));
      const running = ptys
        .filter((pty) => !seen.has(pty.pid))
        .map(({ pid }) => ({ ...UNREAD, pid, pgid: pid, ppid: process.pid }));
      return [...stopped, ...running];
    },
  };
}
