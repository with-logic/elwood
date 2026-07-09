/**
 * Focused unit coverage for the node-pty adapter.
 * Covers PRD §5 and §10.
 */

import { spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { SessionReaper } from "../../src/runtime/reap-tree.ts";
import { loginShellCommand } from "../../src/runtime/shell.ts";
import { terminatePty } from "../../src/runtime/terminate.ts";
import { tempDirForUnit } from "./helpers.ts";

/** A reaper with an injected killer so tests never signal a real process group. */
function testReaper(reaped: number[], pid = 1000) {
  return new SessionReaper(pid, { killGroup: (pgid) => reaped.push(pgid) });
}

describe("node PTY adapter", () => {
  test("C-PTY-02 interactive login shell sources zsh startup files", () => {
    const home = tempDirForUnit();
    writeFileSync(join(home, ".zshrc"), "export ELWOOD_SHELL_PROBE=from_zshrc\n");
    const result = spawnSync("/bin/zsh", loginShellCommand("printf $ELWOOD_SHELL_PROBE"), {
      encoding: "utf8",
      env: { ...process.env, HOME: home, ZDOTDIR: home },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("from_zshrc");
  });

  test("C-PTY-01 wraps a real pseudoterminal process", async () => {
    const calls: string[] = [];
    vi.resetModules();
    vi.doMock("node-pty", () => ({
      spawn: () => ({
        pid: 42,
        onData: (handler: (data: string) => void) => {
          handler("hello");
          return { dispose: () => calls.push("off-data") };
        },
        onExit: (handler: (event: { exitCode: number }) => void) => {
          handler({ exitCode: 0 });
          return { dispose: () => calls.push("off-exit") };
        },
        write: (data: string) => calls.push(`write:${data}`),
        resize: (cols: number, rows: number) => {
          if (cols === 31) throw new Error("ioctl(2) failed, EBADF");
          if (cols === 32) throw new Error("ioctl(2) failed, EINVAL");
          calls.push(`resize:${cols}x${rows}`);
        },
        kill: (signal?: string) => calls.push(`kill:${signal}`),
      }),
    }));
    const { currentPtyFactory, resetRuntimeSeamsForTests } = await import(
      "../../src/runtime/seams.ts"
    );
    const { ensureNodePtySpawnHelperExecutable, nodePtyFactory, nodePtySpawnHelperPath } =
      await import("../../src/pty/node.ts");
    const helper = join(tempDirForUnit(), "spawn-helper");
    writeFileSync(helper, "");
    ensureNodePtySpawnHelperExecutable(helper);
    ensureNodePtySpawnHelperExecutable(join(tempDirForUnit(), "missing-helper"));
    expect(statSync(helper).mode & 0o111).toBeGreaterThan(0);
    expect(nodePtySpawnHelperPath()).toContain("spawn-helper");
    const pty = nodePtyFactory({
      command: "fake",
      args: [],
      cwd: process.cwd(),
      env: process.env,
      size: { cols: 20, rows: 5 },
    });
    let data = "";
    const offData = pty.onData((chunk) => {
      data = chunk;
    });
    let exitCode = -1;
    const offExit = pty.onExit((event) => {
      exitCode = event.exitCode;
    });
    pty.resize({ cols: 30, rows: 10 });
    expect(() => pty.resize({ cols: 31, rows: 10 })).not.toThrow();
    expect(() => pty.resize({ cols: 32, rows: 10 })).toThrow("EINVAL");
    pty.write("hello\n");
    pty.write(new Uint8Array([113, 10]));
    pty.kill();
    offData();
    offExit();
    expect(pty.pid).toBe(42);
    expect(data).toBe("hello");
    expect(exitCode).toBe(0);
    expect(calls).toContain("resize:30x10");
    expect(calls).toContain("write:hello\n");
    expect(calls).toContain("write:q\n");
    expect(calls).toContain("kill:SIGTERM");
    expect(calls).toContain("off-data");
    expect(calls).toContain("off-exit");
    resetRuntimeSeamsForTests();
    const runtimePty = currentPtyFactory()({
      command: "fake",
      args: [],
      cwd: process.cwd(),
      env: process.env,
      size: { cols: 10, rows: 3 },
    });
    const offRuntimeData = runtimePty.onData(() => {});
    const offRuntimeExit = runtimePty.onExit(() => {});
    runtimePty.write("x");
    runtimePty.resize({ cols: 11, rows: 4 });
    runtimePty.kill("SIGKILL");
    offRuntimeData();
    offRuntimeExit();
    expect(runtimePty.pid).toBe(42);
    vi.doUnmock("node-pty");
    vi.resetModules();
  });

  test("C-LIFE-02 graceful termination escalates when the process does not exit", async () => {
    const signals: string[] = [];
    const reaped: number[] = [];
    let exitHandler: (() => void) | undefined;
    await terminatePty(
      {
        pid: 1000,
        onData: () => () => {},
        onExit: (handler) => {
          exitHandler = () => handler({ exitCode: 0 });
          return () => {};
        },
        write: () => {},
        resize: () => "resized",
        kill: (signal) => {
          signals.push(signal ?? "SIGTERM");
          if (signal === "SIGKILL") exitHandler?.();
        },
      },
      "SIGTERM",
      testReaper(reaped),
      { gracefulMs: 0, forceMs: 10 },
    );
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(reaped).toEqual([1000]); // reaped after exit
  });

  test("C-LIFE-10 termination reports failure but STILL reaps the group", async () => {
    // Both timeout branches must reap before returning: a termination_failed
    // outcome that leaks the descendant tree is the exact P0 this guards.
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const reaped: number[] = [];
      await expect(
        terminatePty(
          {
            pid: 1000,
            onData: () => () => {},
            onExit: () => () => {},
            write: () => {},
            resize: () => "resized",
            kill: () => {},
          },
          signal,
          testReaper(reaped),
          { gracefulMs: 0, forceMs: 0 },
        ),
      ).rejects.toMatchObject({ code: "termination_failed" });
      expect(reaped).toEqual([1000]); // reaped despite the failure
    }
  });

  test("C-LIFE-10 a throwing PTY kill still reaps and surfaces the error", async () => {
    for (const thrown of [new Error("pty gone"), "raw string failure"]) {
      const reaped: number[] = [];
      await expect(
        terminatePty(
          {
            pid: 1000,
            onData: () => () => {},
            onExit: () => () => {},
            write: () => {},
            resize: () => "resized",
            kill: () => {
              throw thrown;
            },
          },
          "SIGKILL",
          testReaper(reaped),
          { gracefulMs: 0, forceMs: 0 },
        ),
      ).rejects.toThrow(String(thrown).replace(/^Error: /, ""));
      expect(reaped).toEqual([1000]); // reaped even when the PTY op threw
    }
  });
});
