/**
 * Foreground spawning preserves agent exit codes and maps launch errors.
 * Covers PRD §12A.9 and C-CLI-25 with real local child processes.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  exitStatus,
  type InteractiveLaunch,
  spawnInteractiveAgent,
} from "../../src/cli/interactive/spawn.ts";
import * as shell from "../../src/runtime/shell.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("spawnInteractiveAgent", () => {
  beforeEach(() => {
    // Exercise real child processes without loading the developer's interactive dotfiles.
    const root = mkdtempSync(join(tmpdir(), "elwood-spawn-shell-"));
    roots.push(root);
    const path = join(root, "shell");
    writeFileSync(path, '#!/bin/sh\nshift\nshift\nexec /bin/sh "$@"\n', { mode: 0o700 });
    vi.spyOn(shell, "userShell").mockReturnValue(path);
  });
  test("C-CLI-25 returns the agent's own exit status from a real foreground process", async () => {
    const launch = (args: readonly string[]): InteractiveLaunch => ({
      agent: "codex",
      command: "/bin/sh",
      args,
      cwd: tmpdir(),
    });
    expect(await spawnInteractiveAgent(launch(["-c", "exit 3"]))).toBe(3);
    expect(await spawnInteractiveAgent(launch(["-c", "kill -TERM $$"]))).toBe(143);
  });

  test("C-CLI-25 a missing or unstartable command maps to the adapter's error codes", async () => {
    await expect(
      spawnInteractiveAgent({
        agent: "claude",
        command: join(tmpdir(), "no-such-elwood-agent"),
        args: [],
        cwd: tmpdir(),
      }),
    ).rejects.toMatchObject({ code: "claude_not_found" });
    const root = mkdtempSync(join(tmpdir(), "elwood-interactive-"));
    roots.push(root);
    const notExecutable = join(root, "agent.txt");
    writeFileSync(notExecutable, "not a program", { mode: 0o600 });
    await expect(
      spawnInteractiveAgent({ agent: "codex", command: notExecutable, args: [], cwd: root }),
    ).rejects.toMatchObject({ code: "codex_start_failed" });
  });

  test("C-CLI-25 exit status mapping covers signals without numbers", () => {
    expect(exitStatus(0, null)).toBe(0);
    expect(exitStatus(null, "SIGINT")).toBe(130);
    expect(exitStatus(null, null)).toBe(1);
  });
});
