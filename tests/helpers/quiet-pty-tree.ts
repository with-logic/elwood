/** Owned fake-PTY process rows for adapter lifecycle fixtures (PRD §5.3, C-LIFE-10). */
import type { PtyProcess } from "../../src/pty/types.ts";
import { UNREAD } from "../../src/runtime/shutdown/process-table.ts";
import { quietProcessTree } from "../../src/runtime/shutdown/reap-tree.ts";

const STARTED_AT = "Fri Jan 1 00:00:00 1960";

/** Read the harness registry afresh, with stable old identities through STOP/CONT. */
export function quietPtyTree(ptys: readonly Pick<PtyProcess, "pid">[]) {
  const quiet = quietProcessTree();
  return {
    ...quiet,
    listProcesses: async (...args: Parameters<typeof quiet.listProcesses>) => {
      const stopped = (await quiet.listProcesses(...args)).map((row) => ({
        ...row,
        startedAt: STARTED_AT,
      }));
      const seen = new Set(stopped.map((row) => row.pid));
      const running = ptys
        .filter((pty) => !seen.has(pty.pid))
        .map(({ pid }) => ({
          ...UNREAD,
          pid,
          pgid: pid,
          ppid: process.pid,
          startedAt: STARTED_AT,
        }));
      return [...stopped, ...running];
    },
  };
}
