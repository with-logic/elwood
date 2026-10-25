/**
 * Real-process-seam coverage for the PTY process-group reaper.
 * Covers PRD §5.3 and §9.4 (C-LIFE-10): a descendant reparented to PID 1 is
 * still reaped by a group SIGKILL, which a parent-pid walk could not reach.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node-pty";
import { describe, expect, test } from "vitest";
import { reapProcessGroup } from "../../src/runtime/shutdown/reap-tree.ts";
import { delay, POLL_INTERVAL_MS, pidExists, pollGone } from "../helpers/process-liveness.ts";
import { tempDir } from "../helpers/tmp.ts";

const zsh = "/bin/zsh";
const hasZsh = existsSync(zsh);
if (!hasZsh) console.warn(`SKIPPING reap-tree-real: ${zsh} is not installed on this host`);

describe("C-LIFE-10 process-group reaping (real seams)", () => {
  test.skipIf(!hasZsh)(
    "kills a descendant reparented to PID 1 that a pgrep -P walk would miss",
    async () => {
      // A PTY leader (zsh) whose middle process spawns a long-lived grandchild and
      // then exits. POSIX reparents the grandchild to PID 1 — so `pgrep -P <leader>`
      // finds nothing — but it stays in the leader's group, so a group SIGKILL reaps
      // it. The test PROVES the reparent happened before reaping.
      const marker = tmpMarker();
      const inner =
        "const{spawn}=require('child_process');" +
        `const gc=spawn(process.execPath,['-e','process.title=${JSON.stringify(marker)};setInterval(()=>{},1e9)'],{stdio:'ignore'});` +
        `require('fs').writeFileSync('${marker}',String(gc.pid)+' '+String(process.pid));` +
        "setTimeout(()=>process.exit(0),150);";
      const node = JSON.stringify(process.execPath);
      const pty = spawn(zsh, ["-c", `${node} -e "${inner.replace(/"/g, '\\"')}"; sleep 5`], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
      });
      const [grandchildPid, intermediatePid] = await readPidsWhenWritten(marker);
      try {
        // Wait for the intermediate (the grandchild's original parent) to exit, so
        // the decisive reparent-to-init has actually happened — a recursive parent
        // walker would now find nothing under the leader (the guarantee C-LIFE-10
        // depends on).
        expect(await pollGone({ pid: intermediatePid, timeoutMs: 2_000 })).toBe(true);
        expect(parentPidOf(grandchildPid)).not.toBe(intermediatePid); // reparented
        expect(pidExists(grandchildPid)).toBe(true); // but still alive in the group
        reapProcessGroup(pty.pid);
        expect(await pollGone({ pid: grandchildPid, timeoutMs: 2_000 })).toBe(true);
      } finally {
        // Clean up survivors even if an assertion above failed.
        if (pidExists(grandchildPid)) tryKill(grandchildPid);
        pty.kill();
      }
    },
  );
});

function tmpMarker(): string {
  return join(tempDir("elwood-reap-test-"), "pids.txt");
}

async function readPidsWhenWritten(path: string): Promise<[number, number]> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(path)) {
      const parts = readFileSync(path, "utf8").trim().split(/\s+/).map(Number);
      const gc = parts[0] ?? 0;
      const mid = parts[1] ?? 0;
      if (Number.isInteger(gc) && gc > 0 && Number.isInteger(mid) && mid > 0) return [gc, mid];
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("grandchild/intermediate pids were never written");
}

/** The parent pid of `pid` via `ps`, or -1 if it can't be read (already gone). */
function parentPidOf(pid: number): number {
  try {
    return Number(
      execFileSync("ps", ["-o", "ppid=", "-p", String(pid)])
        .toString()
        .trim(),
    );
  } catch {
    return -1;
  }
}

function tryKill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone: nothing to clean up.
  }
}
