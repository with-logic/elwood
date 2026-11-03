/** A stalled FIFO creator is killed and reaped before setup rejects (PRD §9.2, C-PERF-05). */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { NamedPipeCapture, setMkfifoForTests } from "../../src/runtime/probe/named-pipes.ts";
import { killGroupsWhoseCommandHas } from "../helpers/process-liveness.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const creator = vi.hoisted(() => ({ pid: undefined as number | undefined }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: Parameters<typeof actual.execFile>) => {
      const child = actual.execFile(...args);
      creator.pid = child.pid;
      return child;
    },
  };
});

test("C-PERF-05 capture setup timeout reaps its native child and removes its directory", async () => {
  const root = tempDir("elwood-stalled-setup-");
  const tmp = join(root, "tmp");
  const helper = join(root, "mkfifo");
  mkdirSync(tmp);
  vi.stubEnv("TMPDIR", tmp);
  writeFileSync(
    helper,
    '#!/bin/sh\ntrap "" TERM\n/usr/bin/mkfifo -m "$2" "$3" || exit\nwhile :; do :; done\n',
    { mode: 0o700 },
  );
  setMkfifoForTests(helper);
  let emergencyKill = false;
  const setupTimeoutMs = 750;
  // Allow three extra setup windows for SIGKILL delivery, reaping, and directory cleanup.
  // This guard prevents a broken implementation from leaking the test's own busy child.
  const emergencyKillTimeoutMs = 4 * setupTimeoutMs;
  const safety = setTimeout(() => {
    emergencyKill = true;
    killGroupsWhoseCommandHas(helper);
  }, emergencyKillTimeoutMs);
  try {
    await expect(NamedPipeCapture.create(setupTimeoutMs)).rejects.toMatchObject({
      killed: true,
      signal: "SIGKILL",
    });
    expect(emergencyKill).toBe(false);
    // Node knows the spawned PID even if the timeout precedes the helper's first command.
    const pid = creator.pid;
    if (pid === undefined) throw new Error("The native FIFO creator did not spawn.");
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    expect(readdirSync(tmp)).toEqual([]);
  } finally {
    setMkfifoForTests();
    clearTimeout(safety);
    killGroupsWhoseCommandHas(helper);
  }
});
