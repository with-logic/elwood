/**
 * Starting a session whose working directory was deleted no longer brings it back: state setup
 * makes a state directory only while `cwd` exists, and the start rejects with the adapter's
 * start failure before the agent's PTY is spawned, so the worktree, and a state directory
 * elsewhere, stay gone. A resume whose state directory is removed while it checks the CLI fails
 * without recreating it (PRD §8.1, C-STATE-14, C-API-61).
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import { fakeLaunch, resetFakeLaunch } from "../helpers/fake-launch.ts";
import { resumableStateDir } from "../helpers/session-state.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(resetFakeLaunch);

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
      await expect(start(options), stateDir).rejects.toMatchObject({
        code: `${agent}_start_failed`,
        details: { cwd, errno: "ENOENT" },
      });
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
