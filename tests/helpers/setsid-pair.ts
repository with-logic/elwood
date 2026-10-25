/**
 * Real-process fixtures for the detached-sweep tests (PRD §5.3 and §9.4, C-LIFE-10): a
 * setsid node leader that starts one setsid child, and an unrelated bystander. Cleanup
 * signals only what this test still owns: the child while its command line still
 * carries the pair's unique marker, then the leader and bystander through their own
 * handles.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { killIfCommandHas } from "./process-liveness.ts";

// A detached (setsid) leader that starts one detached child, passing the child the
// marker as an argument so it shows in the child's command line, and prints its pid.
const LEADER_SCRIPT = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", process.argv[1]], {
  detached: true,
  stdio: "ignore",
});
process.stdout.write(child.pid + "\\n");
setInterval(() => {}, 1000);
`;

let pairs = 0;

export type SetsidPair = {
  readonly leader: ChildProcess;
  readonly childPid: number;
  readonly marker: string;
};

/** Starts the pair; resolves once the leader reports its child's pid. */
export async function startSetsidPair(): Promise<SetsidPair> {
  pairs += 1;
  const marker = `elwood-setsid-pair-${process.pid}-${pairs}`;
  const leader = spawn(process.execPath, ["-e", LEADER_SCRIPT, marker], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [chunk] = (await once(leader.stdout as NodeJS.ReadableStream, "data")) as [Buffer];
  return { leader, childPid: Number(chunk.toString().trim()), marker };
}

/** A detached process that descends from this test process, not from any leader. */
export function startBystander(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
}

/** Whether node has seen this handle's process exit (after which its pid may be reused). */
export function hasExited(handle: ChildProcess): boolean {
  return handle.exitCode !== null || handle.signalCode !== null;
}

/** Kills the child while its pid is still the child's, then the leader by its handle. */
export function stopPair(pair: SetsidPair | undefined): void {
  if (pair === undefined) return;
  killIfCommandHas(pair.childPid, pair.marker);
  pair.leader.kill("SIGKILL");
}
