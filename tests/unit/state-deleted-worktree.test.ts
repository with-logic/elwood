/**
 * Starting a session whose working directory was deleted no longer brings it back: state setup
 * makes a state directory only while `cwd` exists, so the start fails before the agent's PTY is
 * spawned, and the worktree, and a state directory elsewhere, stay gone. A resume whose state
 * directory is removed while it checks the CLI fails the same way (PRD §8.1, C-STATE-14).
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { resumableStateDir } from "../helpers/session-state.ts";
import { tempDir } from "../helpers/tmp.ts";

/**
 * Both CLIs' probes succeed, each after `duringProbe` runs; every PTY spawn records its
 * directory and fails.
 */
function fakeLaunch(duringProbe = () => {}): string[] {
  const launchedIn: string[] = [];
  setPlatformForTests("darwin");
  setCommandRunnerForTests((_command, args) => {
    duringProbe();
    const line = args.join(" ");
    const help = "codex --dangerously-bypass-hook-trust\n";
    const version = line.includes("codex") ? "codex-cli 0.132.0\n" : "2.1.144\n";
    return { status: 0, stdout: line.includes("--help") ? help : version, stderr: "" };
  });
  setPtyFactoryForTests((options) => {
    launchedIn.push(options.cwd);
    throw new Error("no PTY in this test");
  });
  return launchedIn;
}

afterEach(() => {
  resetRuntimeSeamsForTests();
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
});

describe.each([
  { agent: "claude", start: startClaude, resume: resumeClaude },
  { agent: "codex", start: startCodex, resume: resumeCodex },
] as const)("$agent", ({ agent, start, resume }) => {
  test(`C-STATE-14 ${agent} start in a deleted worktree fails without recreating it`, async () => {
    const launchedIn = fakeLaunch();
    const cwd = join(tempDir("elwood-deleted-worktree-"), "worktree");
    const elsewhere = join(tempDir("elwood-deleted-worktree-state-"), "state");
    for (const stateDir of [undefined, join(cwd, "state"), elsewhere]) {
      const options = stateDir === undefined ? { cwd } : { cwd, stateDir };
      await expect(start(options), stateDir).rejects.toMatchObject({ code: "ENOENT" });
      expect(existsSync(cwd), "the worktree must not be recreated").toBe(false);
    }
    expect(existsSync(elsewhere), "nor a state directory elsewhere made").toBe(false);
    expect(launchedIn).toEqual([]);
  });

  test(`C-STATE-14 ${agent} resume fails when its state directory goes during preflight`, async () => {
    const elwoodSessionId = `${agent}-state-removed`;
    const stateDir = resumableStateDir(agent, tempDir("elwood-resume-cwd-"), elwoodSessionId);
    const launchedIn = fakeLaunch(() => rmSync(stateDir, { recursive: true, force: true }));
    await expect(resume({ elwoodSessionId, stateDir })).rejects.toMatchObject({ code: "ENOENT" });
    expect(existsSync(stateDir), "the state directory must not be recreated").toBe(false);
    expect(launchedIn).toEqual([]);
  });
});
