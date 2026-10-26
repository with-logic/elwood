/**
 * A session's working directory must already exist (PRD §5.1, §5.2, §5.5, §5.6, C-API-61):
 * start and resume reject with the adapter's start failure before running any probe, never
 * create the directory, and never spawn the agent.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { elwoodError } from "../../src/core/errors.ts";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { recheckLaunchDirectoryOnFailure } from "../../src/runtime/session/launch-directory.ts";
import { replaceDirectory } from "../helpers/replace-directory.ts";
import {
  resumableStateDir as resumable,
  type SessionAdapter,
  sessionState,
} from "../helpers/session-state.ts";
import { tempDir } from "../helpers/tmp.ts";

type Spawned = { probes: number; ptys: number };

/** Counts every probe and PTY spawn; none may happen. */
function watchSpawns(): Spawned {
  const spawned = { probes: 0, ptys: 0 };
  setPlatformForTests("darwin");
  setCommandRunnerForTests(() => {
    spawned.probes += 1;
    return { status: 0, stdout: "", stderr: "" };
  });
  setPtyFactoryForTests(() => {
    spawned.ptys += 1;
    throw new Error("no PTY may start");
  });
  return spawned;
}

/** A state directory holding a resumable record of a session that launched in `cwd`. */
function resumableStateDir(adapter: SessionAdapter, cwd: string): string {
  return resumable(adapter, cwd, `${adapter}-launch-dir`);
}

afterEach(resetRuntimeSeamsForTests);

describe.each([
  { agent: "claude", start: startClaude, resume: resumeClaude },
  { agent: "codex", start: startCodex, resume: resumeCodex },
] as const)("$agent", ({ agent, start, resume }) => {
  test(`C-API-61 ${agent} start in a deleted directory fails and does not recreate it`, async () => {
    const spawned = watchSpawns();
    const cwd = join(tempDir("elwood-launch-dir-"), "deleted-worktree");
    const ownStateDir = join(tempDir("elwood-launch-dir-state-"), "absent", "state");
    for (const stateDir of [undefined, ownStateDir]) {
      const options = stateDir === undefined ? { cwd } : { cwd, stateDir };
      await expect(start(options), stateDir).rejects.toMatchObject({
        code: `${agent}_start_failed`,
        details: { cwd, errno: "ENOENT" },
      });
    }
    expect(existsSync(cwd), "the directory must not be created").toBe(false);
    expect(existsSync(ownStateDir), "no state may be written").toBe(false);
    expect(spawned).toEqual({ probes: 0, ptys: 0 });
  });

  test(`C-API-61 ${agent} start in a path that is a file fails`, async () => {
    const spawned = watchSpawns();
    const cwd = join(tempDir("elwood-launch-dir-"), "a-file");
    writeFileSync(cwd, "");
    await expect(start({ cwd })).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      details: { cwd, errno: "ENOTDIR" },
    });
    expect(spawned).toEqual({ probes: 0, ptys: 0 });
  });

  test(`C-API-61 ${agent} start in a directory that cannot be checked says so`, async () => {
    const spawned = watchSpawns();
    const cwd = join(tempDir("elwood-launch-dir-"), "loop");
    symlinkSync(cwd, cwd);
    await expect(start({ cwd })).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      message: "Could not check the working directory (`cwd`).",
      details: { cwd, errno: "ELOOP" },
    });
    expect(spawned).toEqual({ probes: 0, ptys: 0 });
  });

  test(`C-API-61 ${agent} resume whose recorded directory was deleted fails, leaving its state`, async () => {
    const spawned = watchSpawns();
    const cwd = join(tempDir("elwood-launch-dir-"), "deleted-worktree");
    const stateDir = resumableStateDir(agent, cwd);
    const id = `${agent}-launch-dir`;
    const before = sessionState(stateDir, id);
    await expect(resume({ elwoodSessionId: id, stateDir })).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      details: { cwd, errno: "ENOENT" },
    });
    expect(existsSync(cwd)).toBe(false);
    expect(spawned).toEqual({ probes: 0, ptys: 0 });
    expect(sessionState(stateDir, id)).toEqual(before);
  });
});

test("C-API-61 claude resume checks the cwd it is given, where it relaunches", async () => {
  const spawned = watchSpawns();
  const stateDir = resumableStateDir("claude", tempDir("elwood-launch-dir-recorded-"));
  const cwd = join(tempDir("elwood-launch-dir-"), "deleted-worktree");
  await expect(
    resumeClaude({ elwoodSessionId: "claude-launch-dir", stateDir, cwd }),
  ).rejects.toMatchObject({ code: "claude_start_failed", details: { cwd } });
  expect(spawned).toEqual({ probes: 0, ptys: 0 });
});

test("C-API-61 codex resume checks its recorded directory, where it relaunches", async () => {
  const spawned = watchSpawns();
  const recorded = join(tempDir("elwood-launch-dir-"), "deleted-worktree");
  const stateDir = resumableStateDir("codex", recorded);
  const cwd = tempDir("elwood-launch-dir-given-");
  await expect(
    resumeCodex({ elwoodSessionId: "codex-launch-dir", stateDir, cwd }),
  ).rejects.toMatchObject({ code: "codex_start_failed", details: { cwd: recorded } });
  expect(spawned).toEqual({ probes: 0, ptys: 0 });
});

describe("C-API-61 a launch that fails after its cwd has gone", () => {
  const failures = [
    {
      kind: "typed",
      error: elwoodError("pty_start_failed", "Failed to start the PTY.", {
        cause: "spawn failed",
        cleanupErrorCode: "EPERM",
        cleanupProcessGroupId: 4242,
      }),
      kept: { cause: "spawn failed", cleanupErrorCode: "EPERM", cleanupProcessGroupId: 4242 },
    },
    {
      kind: "raw",
      error: Object.assign(new Error("ENOENT: mkdir"), { code: "ENOENT", syscall: "mkdir" }),
      kept: { cause: "ENOENT: mkdir", syscall: "mkdir" },
    },
  ];
  test.each(failures)("C-API-61 keeps a $kind failure's cause and details", async (failure) => {
    setPlatformForTests("darwin");
    const cwd = join(tempDir("elwood-launch-dir-"), "worktree");
    mkdirSync(cwd);
    const launching = recheckLaunchDirectoryOnFailure("codex", cwd, () => {
      rmSync(cwd, { recursive: true });
      return Promise.reject(failure.error);
    });
    await expect(launching).rejects.toMatchObject({
      code: "codex_start_failed",
      details: { ...failure.kept, cwd, errno: "ENOENT" },
    });
  });

  test("C-API-61 a cwd deleted and made again while the launch failed is not the same one", async () => {
    setPlatformForTests("darwin");
    const cwd = join(tempDir("elwood-launch-dir-"), "worktree");
    mkdirSync(cwd);
    const launching = recheckLaunchDirectoryOnFailure("codex", cwd, () => {
      replaceDirectory(cwd);
      return Promise.reject(Object.assign(new Error("spawn failed"), { code: "EACCES" }));
    });
    const failure = await launching.catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "codex_start_failed",
      message: "The working directory (`cwd`) was replaced by another directory.",
      details: { cause: "spawn failed", cwd },
    });
    expect(failure, "errno is the check's, not the launch's").not.toHaveProperty("details.errno");
  });
});
