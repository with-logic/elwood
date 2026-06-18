/**
 * Process supervisor for the browser dev app.
 * Implements PRD §11.
 */

import { spawn, spawnSync } from "node:child_process";

const child = spawn("node", ["--no-warnings", "src/app/web-dev.ts"], {
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
