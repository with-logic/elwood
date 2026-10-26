/**
 * Symlink-safe new-session state-root coverage.
 * Implements PRD §12A.5 and C-CLI-15.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type CliLaunchDependencies, createCliLaunch } from "../../src/cli/session/launch.ts";
import type { EffectiveRunRequest } from "../../src/cli/types.ts";
import { resetRuntimeSeamsForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import { ensurePrivateStateRoot } from "../../src/state/private-session.ts";
import { tempDir } from "../helpers/tmp.ts";
import { effectiveRequest } from "./main-fakes.ts";

function request(root: string, stateDir: string): EffectiveRunRequest {
  return effectiveRequest({
    trust: false,
    stateDir,
    cwd: root,
    sandbox: "read-only",
    approvalPolicy: "on-request",
  });
}

function dependencies(starts: string[]): CliLaunchDependencies {
  const unavailable = (): Promise<never> => Promise.reject(new Error("unexpected adapter"));
  return {
    prepareStateRoot: ensurePrivateStateRoot,
    startClaude: (_options, id) => {
      starts.push(id);
      return Promise.reject(new Error("startClaude"));
    },
    resumeClaude: unavailable,
    startCodex: (_options, id) => {
      starts.push(id);
      return Promise.reject(new Error("startCodex"));
    },
    resumeCodex: unavailable,
  };
}

describe("CLI new-session state root", () => {
  test("C-CLI-15 creates an absent private root before adapter preparation", async () => {
    const root = tempDir("elwood-cli-state-root-");
    const stateDir = join(root, "state");
    const starts: string[] = [];

    await expect(
      createCliLaunch(request(root, stateDir), "safe", dependencies(starts))(),
    ).rejects.toThrow("startCodex");

    const state = lstatSync(stateDir);
    expect(state.isDirectory()).toBe(true);
    expect(state.uid).toBe(process.getuid!());
    expect(state.mode & 0o777).toBe(0o700);
    expect(starts).toEqual(["safe"]);
  });

  test("C-CLI-15 rejects a linked root without changing its target", async () => {
    const root = tempDir("elwood-cli-state-link-");
    const target = join(root, "target");
    const stateDir = join(root, "state");
    mkdirSync(target);
    chmodSync(target, 0o755);
    writeFileSync(join(target, "owned.txt"), "unchanged\n");
    symlinkSync(target, stateDir);
    const starts: string[] = [];

    await expect(
      createCliLaunch(request(root, stateDir), "unsafe", dependencies(starts))(),
    ).rejects.toMatchObject({ code: "state_corrupt" });

    expect(starts).toEqual([]);
    expect(lstatSync(target).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(target, "owned.txt"), "utf8")).toBe("unchanged\n");
  });

  test("C-CLI-15 rejects a linked sessions directory without changing its target", async () => {
    const root = tempDir("elwood-cli-sessions-link-");
    const target = join(root, "target");
    const stateDir = join(root, "state");
    mkdirSync(target);
    mkdirSync(stateDir);
    chmodSync(target, 0o755);
    symlinkSync(target, join(stateDir, "sessions"));
    const starts: string[] = [];

    await expect(
      createCliLaunch(request(root, stateDir), "unsafe", dependencies(starts))(),
    ).rejects.toMatchObject({ code: "state_corrupt" });

    expect(starts).toEqual([]);
    expect(lstatSync(target).mode & 0o777).toBe(0o755);
  });

  test("C-CLI-15 rejects an existing non-private state root without chmodding it", async () => {
    const root = tempDir("elwood-cli-state-mode-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    chmodSync(stateDir, 0o755);
    const starts: string[] = [];

    await expect(
      createCliLaunch(request(root, stateDir), "shared", dependencies(starts))(),
    ).rejects.toMatchObject({ code: "state_corrupt" });

    expect(starts).toEqual([]);
    expect(lstatSync(stateDir).mode & 0o777).toBe(0o755);
  });

  test.each([
    "claude",
    "codex",
  ] as const)("C-CLI-15 C-API-61 a %s workspace removed once its effective request is built fails the launch, not recreated", async (agent) => {
    setPlatformForTests("darwin"); // where the launch directory is checked
    const cwd = join(tempDir("elwood-cli-state-workspace-"), "worktree");
    mkdirSync(cwd);
    const starts: string[] = [];
    const removed = effectiveRequest({ agent, trust: false, stateDir: join(cwd, "state"), cwd });
    const launch = createCliLaunch(removed, "gone", dependencies(starts));
    // Removed once the effective request (a fixture here, not validated) and the launch are
    // built, before the launch runs.
    rmSync(cwd, { recursive: true });
    try {
      await expect(launch()).rejects.toMatchObject({
        code: `${agent}_start_failed`,
        details: { cwd, errno: "ENOENT" },
      });
    } finally {
      resetRuntimeSeamsForTests();
    }
    expect(existsSync(cwd), "the workspace must not be recreated").toBe(false);
    expect(starts).toEqual([]);
  });
});
