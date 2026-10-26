/**
 * Slow hooks for the real-CLI reap proofs (PRD §5.3 and §9.4, C-LIFE-10): a hook command
 * that records its pid and then sleeps, and the checks that it runs in a process group
 * of its own under the CLI leader, the shape the leader-group SIGKILL alone cannot reach.
 */

import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childPids } from "../../dev/child-lookup.ts";
import { startClaude } from "../../src/index.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import { listProcessTable } from "../../src/runtime/shutdown/process-table.ts";
import { pidExists } from "../helpers/process-liveness.ts";
import { makeProject } from "./helpers.ts";

export const isReaped = (pid: number): boolean => !pidExists(pid);

/**
 * A hook that records its pid, then sleeps for about two minutes. The fraction of a
 * second is random, so `sleep <seconds>` on a command line names only this test's hook:
 * cleanup kills by that marker, never by a pid that may since belong to another process.
 */
export function slowHold(pidFile: string): { readonly command: string; readonly marker: string } {
  const marker = `sleep 120.${randomInt(1e9).toString().padStart(9, "0")}`;
  return { command: `echo $$ > ${shellQuote(pidFile)}; exec ${marker}`, marker };
}

/** The same hook as a Claude project-settings entry. */
function slowHook(command: string): unknown {
  return [{ hooks: [{ type: "command", command, timeout: 600 }] }];
}

export function readHookPid(pidFile: string): number | undefined {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

/**
 * The precondition the leader-group SIGKILL alone cannot handle: the hook runs in
 * its own process group, tied to the CLI leader only by parent pids.
 */
export async function hookShape(hookPid: number, leaders: readonly number[]) {
  const table = await listProcessTable(10_000);
  const parent = (pid: number) => table.find((entry) => entry.pid === pid)?.ppid ?? 1;
  let ancestor = parent(hookPid);
  while (ancestor > 1 && !leaders.includes(ancestor)) ancestor = parent(ancestor);
  const row = table.find((entry) => entry.pid === hookPid);
  return { ownGroup: row?.pgid === hookPid, descendsFromLeader: ancestor > 1 };
}
export const detached = { ownGroup: true, descendsFromLeader: true };

/** Starts Claude in a project whose own settings add one slow hook for `event`. */
export async function startWithSlowHook(event: "SessionStart" | "SessionEnd") {
  const project = makeProject("claude");
  const pidFile = join(project.cwd, "hook.pid");
  const hold = slowHold(pidFile);
  mkdirSync(join(project.cwd, ".claude"), { recursive: true });
  const settings = { hooks: { [event]: slowHook(hold.command) } };
  writeFileSync(join(project.cwd, ".claude", "settings.json"), JSON.stringify(settings));
  const before = new Set(childPids(process.pid));
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
  });
  const leaders = childPids(process.pid).filter((pid) => !before.has(pid));
  return { session, leaders, pidFile, marker: hold.marker };
}
