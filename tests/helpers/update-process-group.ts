/** Real detached updater fixtures with bounded group cleanup (PRD §9.2, C-PERF-04). */
import { ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { processGroupGone } from "../../src/runtime/probe/cleanup.ts";

/** Await spawn errors before exposing a PID, then clean up the entire owned group. */
export async function spawnUpdateProcessGroup(): Promise<{
  readonly id: number;
  readonly killGroup: () => Promise<void>;
}> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  await once(child, "spawn");
  child.unref();
  ok(child.pid !== undefined, "fixture process did not receive a PID");
  const id = child.pid;
  const killGroup = async (): Promise<void> => {
    if (processGroupGone(id)) return;
    process.kill(-id, "SIGKILL");
    const deadline = Date.now() + 5_000;
    // Observe the same group predicate as production: close alone can race macOS reaping.
    while (!processGroupGone(id) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    if (!processGroupGone(id)) throw new Error(`fixture process group ${id} outlived SIGKILL`);
  };
  return { id, killGroup };
}
