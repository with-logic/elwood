/**
 * Process supervisor for PTY-owning developer entrypoints (`npm run dev:web` and the
 * `example:*` scripts). Implements PRD §11: the entry runs under the SAME Node binary
 * as the supervisor, in its own process group, so a terminal Ctrl-C (or the
 * supervisor's own exit) SIGKILLs the entire spawned tree even when the app-level
 * handler or an agent child is wedged. The child's exit status is mirrored.
 *
 *   node --no-warnings scripts/supervise.ts <entry.ts> [...args]
 */

import { spawn, spawnSync } from "node:child_process";

const [, , entry, ...args] = process.argv;
if (!entry) {
  process.stderr.write("Usage: node scripts/supervise.ts <entry.ts> [...args]\n");
  process.exit(2);
}

const child = spawn(process.execPath, ["--no-warnings", entry, ...args], {
  detached: true,
  env: process.env,
  stdio: "inherit",
});

let exiting = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => hardExit(signal));
}
process.on("exit", () => killTree(child.pid));
child.on("exit", (code, signal) => {
  if (exiting) return;
  process.exit(exitCode(code, signal));
});

function hardExit(signal: NodeJS.Signals): never {
  exiting = true;
  killTree(child.pid);
  try {
    process.kill(process.pid, "SIGKILL");
  } catch {
    process.exit(exitCode(null, signal));
  }
  return process.exit(137);
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  for (const childPid of childPids(pid)) killTree(childPid);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process may have already exited.
    }
  }
}

function childPids(pid: number): readonly number[] {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGHUP") return 129;
  return 130;
}
