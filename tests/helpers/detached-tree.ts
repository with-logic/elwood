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

import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";
import { nodePtyFactory } from "../../src/pty/node.ts";
import type { PtyProcess } from "../../src/pty/types.ts";
import { listProcessTable } from "../../src/runtime/shutdown/process-table.ts";
import { delay, killGroupsWhoseCommandHas, POLL_INTERVAL_MS } from "./process-liveness.ts";
import { tempDir } from "./tmp.ts";

/** Where `with-daemon` puts its copies of Node, named as the Codex TUI and its daemon are. */
const TUI_BINARY = "bin/codex";
const DAEMON_BINARY = "packages/app-server-daemon/releases/0.164.0/bin/codex";
/** Node itself, for the hooks and the MCP server, which run from neither copy. */
const NODE = realpathSync(process.execPath);
/** How long a test waits for a process of the tree to record its pid. */
const PID_FILE_WAIT_TIMEOUT_MS = 10_000;

// `hold.cjs <dir> <name> [next] [mode] [...]`: records its pid as <dir>/<name>.pid,
// optionally starts `next` DETACHED from plain Node (Node's `detached` is `setsid()`, as
// the CLIs do for hooks, which run as `sh` and `node`), and stays alive. `ignore-term`
// makes the PTY leader ignore SIGTERM, like a CLI whose graceful shutdown is stuck.
// `with-daemon` runs the leader from a copy of
// Node named `codex` and has it start, detached and with their real arguments, the
// Codex 0.164 TUI's app-server `daemon` (which starts an `mcp` server from plain Node)
// and its `updater` loop, from a copy at the daemon's install (docs/cli-behavior.md).
// `becomes-daemon` runs the leader from that `codex` copy too, and has it start a setsid
// `becoming` child from it, which, once `<dir>/exec` exists, sets its title to the
// daemon's path, which macOS `ps` reads as its `comm`, as an `exec` of the daemon would.
const HOLD = `
const { spawn } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const [dir, name, next, mode] = process.argv.slice(2);
const start = (binary, args) => spawn(binary, [__filename, dir, ...args], { detached: true, stdio: "ignore" });
if (mode === "ignore-term") process.on("SIGTERM", () => {});
if (next) start(${JSON.stringify(NODE)}, [next, next === "child" ? "grandchild" : ""]);
if (mode === "with-daemon") {
  start(dir + "/${DAEMON_BINARY}", ["daemon", "mcp", "", "app-server", "--listen", "unix://", "--analytics-default-enabled", "--managed-daemon"]);
  start(dir + "/${DAEMON_BINARY}", ["updater", "", "", "app-server", "daemon", "pid-update-loop"]);
}
if (mode === "becomes-daemon") start(process.execPath, ["becoming", "", "becoming"]);
const exec = () => {
  if (!existsSync(dir + "/exec")) return setTimeout(exec, 2);
  process.title = dir + "/${DAEMON_BINARY}";
  writeFileSync(dir + "/became", "");
};
if (mode === "becoming") exec();
writeFileSync(dir + "/" + name + ".pid", String(process.pid));
setInterval(() => {}, 1e9);
`;

export type DetachedTree = { readonly pty: PtyProcess; readonly dir: string };

/** Starts the leader under a real PTY; it starts the detached child, which starts the grandchild. */
export function startDetachedTree(
  mode: "" | "ignore-term" | "with-daemon" | "becomes-daemon" = "",
): DetachedTree {
  const dir = holdDir("elwood-detached-");
  const asCodex = mode === "with-daemon" || mode === "becomes-daemon";
  const command = asCodex ? join(dir, TUI_BINARY) : process.execPath;
  if (asCodex) {
    for (const binary of [TUI_BINARY, DAEMON_BINARY].map((path) => join(dir, path))) {
      // A clone where the file system allows one: instant, and no extra space on APFS.
      mkdirSync(dirname(binary), { recursive: true });
      copyFileSync(NODE, binary, constants.COPYFILE_FICLONE);
    }
  }
  const pty = nodePtyFactory({
    command,
    args: [join(dir, "hold.cjs"), dir, "leader", "child", mode],
    cwd: dir,
    env: process.env,
    size: { cols: 80, rows: 24 },
  });
  return { pty, dir };
}

/** Waits for the pid file of `name`, a process a `with-daemon` or `becomes-daemon` leader starts. */
export async function extraPid(
  tree: DetachedTree,
  name: "daemon" | "mcp" | "updater" | "becoming",
): Promise<number> {
  const pid = await waitForPid(tree.dir, name, PID_FILE_WAIT_TIMEOUT_MS);
  if (pid === undefined) throw new Error(`the ${name} process never started`);
  return pid;
}

/** Waits for the detached child's and grandchild's pid files (the leader is `pty.pid`). */
export async function detachedDescendantPids(tree: DetachedTree): Promise<[number, number]> {
  const child = await waitForPid(tree.dir, "child", PID_FILE_WAIT_TIMEOUT_MS);
  const grandchild = await waitForPid(tree.dir, "grandchild", PID_FILE_WAIT_TIMEOUT_MS);
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
