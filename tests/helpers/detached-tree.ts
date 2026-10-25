/**
 * A real process tree in the shape Claude and Codex give a hook in flight, for the
 * detached-sweep proofs (PRD §5.3 and §9.4, C-LIFE-10): a PTY leader whose child, and
 * that child's own child, each start with `setsid()`, so each heads its own session
 * and process group and is tied to its parent only by its parent pid. Everything here
 * is scoped to processes the calling test spawned: cleanup kills a pid only while its
 * command line still names this tree's own temp directory.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodePtyFactory } from "../../src/pty/node.ts";
import type { PtyProcess } from "../../src/pty/types.ts";
import { listProcessTable } from "../../src/runtime/shutdown/process-table.ts";
import { delay, killIfCommandHas } from "./process-liveness.ts";
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

/** Starts a detached process that is NOT the leader's descendant. */
export function startBystander(): ChildProcess {
  const dir = holdDir("elwood-bystander-");
  const bystander = spawn(process.execPath, [join(dir, "hold.cjs"), dir, "bystander"], {
    detached: true,
    stdio: "ignore",
  });
  bystander.unref();
  return bystander;
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

/** The parent and group of each process, to prove the detached precondition. */
export async function shape(pids: readonly number[]): Promise<Record<number, string>> {
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
 * Cleans up anything the test started even when an assertion failed, including a tree
 * only partly up. Each process starts its detached successor before writing its own
 * pid, so once a pid file exists its successor's will follow.
 */
export async function killSurvivors(tree: DetachedTree): Promise<void> {
  killIfCommandHas(tree.pty.pid, tree.dir);
  for (const name of ["child", "grandchild"]) {
    const pid = await waitForPid(tree.dir, name, 2_000);
    if (pid === undefined) return;
    killIfCommandHas(pid, tree.dir);
  }
}

function holdDir(prefix: string): string {
  const dir = tempDir(prefix);
  writeFileSync(join(dir, "hold.cjs"), HOLD);
  return dir;
}

async function waitForPid(dir: string, name: string, ms: number): Promise<number | undefined> {
  for (let waited = 0; waited <= ms; waited += 20) {
    const pid = readPid(dir, name);
    if (pid !== undefined) return pid;
    await delay(20);
  }
  return undefined;
}

function readPid(dir: string, name: string): number | undefined {
  const path = join(dir, `${name}.pid`);
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, "utf8"));
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}
