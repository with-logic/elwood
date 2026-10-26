/**
 * A real process tree in the shape Claude and Codex give a hook in flight, for the
 * detached-sweep proofs (PRD §5.3 and §9.4, C-LIFE-10): a PTY leader whose child, and
 * that child's own child, each start with `setsid()`, so each heads its own session
 * and process group and is tied to its parent only by its parent pid. Everything here
 * is scoped to processes the calling test spawned: cleanup kills a process only while
 * its command line names this tree's own temp directory, and it runs when the test
 * finishes however it ends, so a failed sweep, a thrown assertion, or a timeout cannot
 * leave the tree running.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { nodePtyFactory } from "../../src/pty/node.ts";
import type { PtyProcess } from "../../src/pty/types.ts";
import { listProcessTable } from "../../src/runtime/shutdown/process-table.ts";
import { delay, killGroupsWhoseCommandHas, POLL_INTERVAL_MS } from "./process-liveness.ts";
import { tempDir } from "./tmp.ts";

// `hold.cjs <dir> <name> [next] [mode]`: records its pid as <dir>/<name>.pid, optionally
// starts `next` DETACHED (Node's `detached` is `setsid()`, as Claude does for hooks),
// and stays alive. `ignore-term` makes the PTY leader ignore SIGTERM like a CLI whose
// graceful shutdown is stuck, forcing the SIGKILL escalation.
const HOLD = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const [dir, name, next, mode] = process.argv.slice(2);
if (mode === "ignore-term") process.on("SIGTERM", () => {});
if (next) spawn(process.execPath, [__filename, dir, next, next === "child" ? "grandchild" : ""], { detached: true, stdio: "ignore" });
writeFileSync(dir + "/" + name + ".pid", String(process.pid));
setInterval(() => {}, 1e9);
`;

export type DetachedTree = { readonly pty: PtyProcess; readonly dir: string };

/** Starts the leader under a real PTY; it starts the detached child, which starts the grandchild. */
export function startDetachedTree(mode: "" | "ignore-term" = ""): DetachedTree {
  const dir = holdDir("elwood-detached-");
  const pty = nodePtyFactory({
    command: process.execPath,
    args: [join(dir, "hold.cjs"), dir, "leader", "child", mode],
    cwd: dir,
    env: process.env,
    size: { cols: 80, rows: 24 },
  });
  return { pty, dir };
}

/** Waits for the detached child's and grandchild's pid files (the leader is `pty.pid`). */
export async function detachedDescendantPids(tree: DetachedTree): Promise<[number, number]> {
  const child = await waitForPid(tree.dir, "child", 10_000);
  const grandchild = await waitForPid(tree.dir, "grandchild", 10_000);
  if (child === undefined || grandchild === undefined) {
    throw new Error("the detached tree never started");
  }
  return [child, grandchild];
}

/** Each process's parent and group as the real table shows them, for `detachedShape`. */
export async function observedProcessShape(
  pids: readonly number[],
): Promise<Record<number, string>> {
  const table = await listProcessTable(10_000);
  const result: Record<number, string> = {};
  for (const pid of pids) {
    const row = table.find((entry) => entry.pid === pid);
    result[pid] = row ? `ppid=${row.ppid} pgid=${row.pgid}` : "missing";
  }
  return result;
}

/** Each process heads its own group and is tied to its parent only by ppid. */
export function detachedShape(
  leader: number,
  child: number,
  grandchild: number,
): Record<number, string> {
  return {
    [leader]: `ppid=${process.pid} pgid=${leader}`,
    [child]: `ppid=${leader} pgid=${child}`,
    [grandchild]: `ppid=${child} pgid=${grandchild}`,
  };
}

/**
 * Ends every process running from `dir` (a tree's leader, child and grandchild, or any
 * part of one) by SIGKILLing each one's group until a read finds none, and throws if
 * one outlives five seconds. It needs no pid file, because a process starts its
 * successor before it records its own pid, and a timed-out test's directory may
 * already be gone.
 */
export async function killTreeIn(dir: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (killGroupsWhoseCommandHas(dir) > 0) {
    if (performance.now() >= deadline) throw new Error(`a process from ${dir} outlived cleanup`);
    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * Writes the hold script into a fresh temp directory and returns that directory. When
 * the test finishes, every process running from it is killed (`killTreeIn`) before the
 * directory is removed: Vitest runs a test's finish hooks last-registered first.
 */
export function holdDir(prefix: string): string {
  const dir = tempDir(prefix);
  writeFileSync(join(dir, "hold.cjs"), HOLD);
  onTestFinished(() => killTreeIn(dir));
  return dir;
}

async function waitForPid(dir: string, name: string, ms: number): Promise<number | undefined> {
  const deadline = performance.now() + ms;
  for (;;) {
    const pid = readPid(dir, name);
    if (pid !== undefined || performance.now() >= deadline) return pid;
    await delay(POLL_INTERVAL_MS);
  }
}

function readPid(dir: string, name: string): number | undefined {
  const path = join(dir, `${name}.pid`);
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, "utf8"));
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}
