/**
 * A real setsid process pair for the process-table and sweep tests (PRD §5.3 and §9.4,
 * C-LIFE-10): a detached node leader that starts one detached child, and an unrelated
 * detached bystander. The test owns the
 * leader's handle and the leader owns the child's, so cleanup goes through handles: a
 * SIGTERM asks the leader to SIGKILL its child, wait for the child's exit, and exit. Only
 * a child whose leader is already gone falls back to `killIfCommandHas`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { killIfCommandHas, pidExists, pollGone } from "./process-liveness.ts";

// The child gets the marker as an argument, so it shows in the child's command line.
const LEADER_SCRIPT = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", process.argv[1]], {
  detached: true,
  stdio: "ignore",
});
process.on("SIGTERM", () => {
  child.once("exit", () => process.exit(0));
  child.kill("SIGKILL");
});
process.stdout.write(child.pid + "\\n");
setInterval(() => {}, 1000);
`;

const EXIT_WAIT_MS = 5_000;

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
  try {
    const [chunk] = (await once(leader.stdout as NodeJS.ReadableStream, "data")) as [Buffer];
    return { leader, childPid: Number(chunk.toString().trim()), marker };
  } catch (error) {
    // The leader may already have started its child: its SIGTERM handler ends both.
    await stopLeader(leader);
    throw error;
  }
}

/** A detached process that descends from this test process, not from any leader. */
export function startBystander(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
}

/** SIGKILLs a bystander and waits until node has seen it exit, so it never outlives its test. */
export async function stopBystander(bystander: ChildProcess): Promise<void> {
  if (hasExited(bystander)) return;
  const exited = once(bystander, "exit");
  bystander.kill("SIGKILL");
  await exited;
}

/** Whether node has seen this handle's process exit (after which its pid may be reused). */
export function hasExited(handle: ChildProcess): boolean {
  return handle.exitCode !== null || handle.signalCode !== null;
}

/** Ends the pair and waits until both processes are gone; throws if either outlives it. */
export async function stopPair(pair: SetsidPair | undefined): Promise<void> {
  if (pair === undefined) return;
  const { leader, childPid, marker } = pair;
  await stopLeader(leader);
  // A child that outlived its leader is out of every handle's reach.
  if (pidExists(childPid)) killIfCommandHas(childPid, marker);
  if (!(await pollGone({ pid: childPid, timeoutMs: EXIT_WAIT_MS }))) {
    throw new Error(`setsid child ${childPid} outlived cleanup`);
  }
}

/** Resumes the leader if stopped, asks it to end its child and exit, then SIGKILLs it. */
async function stopLeader(leader: ChildProcess): Promise<void> {
  if (hasExited(leader)) return;
  const exited = once(leader, "exit");
  leader.kill("SIGCONT");
  leader.kill("SIGTERM");
  const timer = setTimeout(() => leader.kill("SIGKILL"), EXIT_WAIT_MS);
  await exited;
  clearTimeout(timer);
}
