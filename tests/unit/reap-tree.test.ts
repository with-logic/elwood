/**
 * Focused coverage for the PTY process-group reaper.
 * Covers PRD §5.3 and §9.4 (C-LIFE-10).
 */

import { spawn } from "node-pty";
import { describe, expect, test } from "vitest";
import type { PtyExit } from "../../src/pty/types.ts";
import { reapProcessGroup, rethrowUnlessGroupGone } from "../../src/runtime/reap-tree.ts";
import { reap, terminatePty } from "../../src/runtime/terminate.ts";

const LEADER = 1000;

describe("C-LIFE-10 process-group reaping", () => {
  test("SIGKILLs the leader's process group", () => {
    const killed: number[] = [];
    reapProcessGroup(LEADER, { killGroup: (pgid) => killed.push(pgid) });
    expect(killed).toEqual([LEADER]);
  });

  test("refuses a system-range group id", () => {
    let touched = false;
    for (const pid of [1, 42, 99]) {
      reapProcessGroup(pid, {
        killGroup: () => {
          touched = true;
        },
      });
    }
    expect(touched).toBe(false);
  });

  test("real seams: reaping an already-dead group is a harmless no-op (ESRCH)", () => {
    // A high, almost-certainly-unused pid; the default killer must swallow ESRCH.
    expect(() => reapProcessGroup(999_999)).not.toThrow();
  });

  test("swallows ESRCH but re-throws any other kill failure", () => {
    expect(() => rethrowUnlessGroupGone({ code: "ESRCH" })).not.toThrow();
    expect(() => rethrowUnlessGroupGone({ code: "EPERM" })).toThrow();
  });

  test("terminate.reap uses the default group killer when none is injected", () => {
    // Low pid is refused by the guard, so the default (real) killer is reached
    // but performs no signal — exercising the no-injected-killer branch safely.
    expect(() => reap({ pid: 1 } as never, undefined)).not.toThrow();
  });

  test("terminatePty reaps the leader's group with an injected killer after exit", async () => {
    const killed: number[] = [];
    const pty = {
      pid: LEADER,
      onData: () => () => {},
      onExit: (handler: (exit: PtyExit) => void) => {
        queueMicrotask(() => handler({ exitCode: 0 }));
        return () => {};
      },
      write: () => {},
      resize: () => "resized" as const,
      kill: () => {},
    };
    await terminatePty(
      pty,
      "SIGKILL",
      { gracefulMs: 0, forceMs: 10 },
      {
        killGroup: (pgid) => killed.push(pgid),
      },
    );
    expect(killed).toEqual([LEADER]);
  });

  test("real seams: kills a descendant reparented to PID 1 that a pgrep -P walk would miss", async () => {
    // Reproduces the hook-bridge leak shape: a PTY leader (zsh) whose middle
    // process spawns a long-lived grandchild and then exits. POSIX reparents the
    // grandchild to PID 1 — so `pgrep -P <leader>` finds nothing — but it stays
    // in the leader's process group, so a group SIGKILL still reaps it.
    const marker = `${tmpMarker()}`;
    const inner =
      "const{spawn}=require('child_process');" +
      `const gc=spawn(process.execPath,['-e','process.title=${JSON.stringify(marker)};setInterval(()=>{},1e9)'],{stdio:'ignore'});` +
      `require('fs').writeFileSync('${marker}',String(gc.pid));` +
      "setTimeout(()=>process.exit(0),150);";
    const pty = spawn("/bin/zsh", ["-c", `node -e "${inner.replace(/"/g, '\\"')}"; sleep 5`], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
    });
    const leader = pty.pid;
    const grandchildPid = await readPidWhenWritten(marker);
    // The grandchild has been reparented to init but shares the leader's group.
    expect(processAlive(grandchildPid)).toBe(true);
    reapProcessGroup(leader);
    expect(await pollGone(grandchildPid)).toBe(true);
  });
});

let markerCounter = 0;
function tmpMarker(): string {
  markerCounter += 1;
  return `/tmp/elwood-reap-test-${process.pid}-${markerCounter}.pid`;
}

async function readPidWhenWritten(path: string): Promise<number> {
  const { existsSync, readFileSync } = await import("node:fs");
  for (let i = 0; i < 200; i++) {
    if (existsSync(path)) {
      const value = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(value) && value > 0) return value;
    }
    await delay(20);
  }
  throw new Error("grandchild pid was never written");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pollGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!processAlive(pid)) return true;
    await delay(20);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
