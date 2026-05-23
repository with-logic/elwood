/**
 * Focused unit coverage for the node-pty adapter.
 * Covers PRD §5 and §10.
 */

import { describe, expect, mock, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentPtyFactory, resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { tempDirForUnit } from "./helpers.ts";

describe("node PTY adapter", () => {
  test("C-PTY-01 wraps a real pseudoterminal process", async () => {
    const calls: string[] = [];
    mock.module("node-pty", () => ({
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
        resize: (cols: number, rows: number) => calls.push(`resize:${cols}x${rows}`),
        kill: (signal?: string) => calls.push(`kill:${signal}`),
      }),
    }));
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
  });
});
