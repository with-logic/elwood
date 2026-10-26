/**
 * A session's working directory can go away, or `process.cwd()` can change, while preflight
 * or the launch runs. Start and resume check the directory again after preflight, never
 * recreate it, report its loss as the start failure, and launch Claude in the directory they
 * checked (PRD §5.1, §5.2, §5.5, §5.6, C-API-61).
 */

import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import { fakeLaunch, resetFakeLaunch, resetPreflightCaches } from "../helpers/fake-launch.ts";
import {
  resumableStateDir as resumable,
  type SessionAdapter,
  sessionState,
} from "../helpers/session-state.ts";
import { tempDir } from "../helpers/tmp.ts";

/** A state directory holding a resumable record of a session that launched in `cwd`. */
function resumableStateDir(adapter: SessionAdapter, cwd: string): string {
  return resumable(adapter, cwd, `${adapter}-preflight`);
}

function worktree(): string {
  const cwd = join(realpathSync(tempDir("elwood-launch-dir-")), "worktree");
  mkdirSync(cwd);
  return cwd;
}

afterEach(resetFakeLaunch);

type ResumeOptions = { readonly elwoodSessionId: string; readonly stateDir: string };

describe.each([
  {
    agent: "claude",
    start: startClaude,
    resume: (options: ResumeOptions) => resumeClaude(options),
    // With a posture the record lacks, so a resume that wrote its record before failing shows.
    resumeRepostured: (options: ResumeOptions) =>
      resumeClaude({ ...options, permissionMode: "plan" }),
  },
  {
    agent: "codex",
    start: startCodex,
    resume: (options: ResumeOptions) => resumeCodex(options),
    resumeRepostured: (options: ResumeOptions) => resumeCodex({ ...options, sandbox: "read-only" }),
  },
] as const)("$agent", ({ agent, start, resume, resumeRepostured }) => {
  test(`C-API-61 ${agent} start whose directory is removed during preflight fails without recreating it`, async () => {
    const cwd = worktree();
    const launchedIn = fakeLaunch(() => rmSync(cwd, { recursive: true }));
    await expect(start({ cwd })).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      details: { cwd, errno: "ENOENT" },
    });
    expect(existsSync(cwd), "the directory must not be recreated").toBe(false);
    expect(launchedIn).toEqual([]);
  });

  test(`C-API-61 ${agent} start with its own stateDir, whose directory is removed during preflight, makes neither`, async () => {
    const cwd = worktree();
    const elsewhere = join(tempDir("elwood-launch-dir-state-"), "absent", "state");
    for (const stateDir of [join(cwd, "state", "nested"), elsewhere]) {
      mkdirSync(cwd, { recursive: true });
      resetPreflightCaches(); // so this start's preflight probes again
      fakeLaunch(() => rmSync(cwd, { recursive: true }));
      await expect(start({ cwd, stateDir }), stateDir).rejects.toMatchObject({
        code: `${agent}_start_failed`,
        details: { cwd, errno: "ENOENT" },
      });
      expect(existsSync(cwd), "the directory must not be recreated").toBe(false);
      expect(existsSync(stateDir), "no state may be written").toBe(false);
    }
  });

  test(`C-API-61 ${agent} resume whose directory is removed during preflight fails, leaving its state`, async () => {
    const cwd = worktree();
    const id = `${agent}-preflight`;
    const stateDir = resumableStateDir(agent, cwd);
    const before = sessionState(stateDir, id);
    const launchedIn = fakeLaunch(() => rmSync(cwd, { recursive: true }));
    await expect(resumeRepostured({ elwoodSessionId: id, stateDir })).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      details: { cwd, errno: "ENOENT" },
    });
    expect(existsSync(cwd)).toBe(false);
    expect(launchedIn).toEqual([]);
    expect(sessionState(stateDir, id)).toEqual(before);
  });

  test(`C-API-61 ${agent} start whose directory is removed while it launches reports that`, async () => {
    const cwd = worktree();
    const launchedIn = fakeLaunch(undefined, () => rmSync(cwd, { recursive: true }));
    await expect(start({ cwd })).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      details: { cwd, errno: "ENOENT" },
    });
    expect(launchedIn).toEqual([cwd]);
    expect(existsSync(cwd), "the directory must not be recreated").toBe(false);
  });

  test(`C-API-61 ${agent} resume whose directory is removed while it launches reports that`, async () => {
    const cwd = worktree();
    const stateDir = resumableStateDir(agent, cwd);
    fakeLaunch(undefined, () => rmSync(cwd, { recursive: true }));
    await expect(resume({ elwoodSessionId: `${agent}-preflight`, stateDir })).rejects.toMatchObject(
      { code: `${agent}_start_failed`, details: { cwd, errno: "ENOENT" } },
    );
    expect(existsSync(cwd)).toBe(false);
  });
});

test("C-API-61 claude resume launches in the cwd it checked, though process.cwd() changes during preflight", async () => {
  const base = realpathSync(tempDir("elwood-launch-dir-base-"));
  const elsewhere = realpathSync(tempDir("elwood-launch-dir-elsewhere-"));
  for (const root of [base, elsewhere]) mkdirSync(join(root, "project"));
  // Recorded elsewhere, so a resume that launched in the record's directory shows.
  const stateDir = resumableStateDir("claude", tempDir("elwood-launch-dir-recorded-"));
  const previous = process.cwd();
  const launchedIn = fakeLaunch(() => process.chdir(elsewhere));
  process.chdir(base);
  try {
    const resuming = resumeClaude({
      elwoodSessionId: "claude-preflight",
      stateDir,
      cwd: "project",
    });
    await expect(resuming).rejects.toMatchObject({ code: "pty_start_failed" });
  } finally {
    process.chdir(previous);
  }
  expect(launchedIn).toEqual([join(base, "project")]);
});
