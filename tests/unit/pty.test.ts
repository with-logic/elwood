/**
 * Unit coverage for the node-pty adapter and the shared PTY termination helper.
 * Covers PRD §4.1, §4.2, §5.3, §9.4 (C-PTY-01/02, C-LIFE-02/10). node-pty itself is
 * mocked here (the real PTY is exercised by the adapter conformance suites); the
 * zsh startup-file test runs only where `/bin/zsh` exists.
 */

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loginShellCommand } from "../../src/runtime/shell.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { tempDir } from "../helpers/tmp.ts";

const zsh = "/bin/zsh";
const hasZsh = existsSync(zsh);
if (!hasZsh) console.warn(`SKIPPING C-PTY-02: ${zsh} is not installed on this host`);

/** A reaper with an injected killer so tests never signal a real process group. */
function testReaper(reaped: number[], pid = 1000) {
  return new SessionReaper(pid, { killGroup: (pgid) => reaped.push(pgid) });
}

afterEach(() => {
  vi.doUnmock("node-pty");
  vi.resetModules();
});

describe("node PTY adapter", () => {
  test.skipIf(!hasZsh)("C-PTY-02 interactive login shell sources zsh startup files", () => {
    const home = tempDir("elwood-unit-");
    writeFileSync(join(home, ".zshrc"), "export ELWOOD_SHELL_PROBE=from_zshrc\n");
    const result = spawnSync(zsh, loginShellCommand("printf $ELWOOD_SHELL_PROBE"), {
      encoding: "utf8",
      env: { ...process.env, HOME: home, ZDOTDIR: home },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("from_zshrc");
  });

  test("C-PTY-01 adapts node-pty's spawn API to PtyProcess (node-pty mocked)", async () => {
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
    const { currentPtyFactory } = await import("../../src/runtime/seams.ts");
    const { nodePtyFactory, nodePtySpawnHelperPath } = await import("../../src/pty/node.ts");
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
    expect(pty.resize({ cols: 31, rows: 10 })).toBe("closed"); // EBADF: exit race, ignored
    expect(() => pty.resize({ cols: 32, rows: 10 })).toThrow("EINVAL");
    pty.write("hello\n");
    pty.write(new Uint8Array([113, 10]));
    pty.kill();
    offData();
    offExit();
    expect(pty.pid).toBe(42);
    expect(data).toBe("hello");
    expect(exitCode).toBe(0);
    expect(calls).toEqual(
      expect.arrayContaining(["resize:30x10", "write:hello\n", "write:q\n", "kill:SIGTERM"]),
    );
    expect(calls).toEqual(expect.arrayContaining(["off-data", "off-exit"]));
    // The runtime seam defaults to this same factory.
    const runtimePty = currentPtyFactory()({
      command: "fake",
      args: [],
      cwd: process.cwd(),
      env: process.env,
      size: { cols: 10, rows: 3 },
    });
    runtimePty.onData(() => {})();
    runtimePty.onExit(() => {})();
    runtimePty.write("x");
    runtimePty.resize({ cols: 11, rows: 4 });
    runtimePty.kill("SIGKILL");
    expect(runtimePty.pid).toBe(42);
    expect(calls).toContain("kill:SIGKILL");
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
    // outcome that leaks the descendant tree is the exact leak this guards.
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
