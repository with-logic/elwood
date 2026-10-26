/**
 * A relative `cwd` can't be resolved once the process's own working directory is deleted, and
 * that is the adapter's start failure, naming the `cwd` given, before any probe or spawn
 * (PRD §5.1, §5.2, §5.5, C-API-61).
 */

import { rmSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { resumeClaude, startClaude, startCodex } from "../../src/index.ts";
import { fakeLaunch, resetFakeLaunch } from "../helpers/fake-launch.ts";
import { resumableStateDir } from "../helpers/session-state.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(resetFakeLaunch);

const launches = [
  { name: "claude start", agent: "claude", launch: (cwd: string) => startClaude({ cwd }) },
  { name: "codex start", agent: "codex", launch: (cwd: string) => startCodex({ cwd }) },
  {
    name: "claude resume",
    agent: "claude",
    launch: (cwd: string) => {
      const stateDir = resumableStateDir("claude", tempDir("elwood-relative-"), "claude-relative");
      return resumeClaude({ elwoodSessionId: "claude-relative", stateDir, cwd });
    },
  },
] as const;

test.each(
  launches,
)("C-API-61 $name with a relative cwd, in a deleted process directory, fails", async (each) => {
  let probes = 0;
  const launchedIn = fakeLaunch(() => probes++);
  const previous = process.cwd();
  const deleted = tempDir("elwood-relative-process-cwd-");
  process.chdir(deleted);
  rmSync(deleted, { recursive: true });
  try {
    await expect(each.launch("project")).rejects.toMatchObject({
      code: `${each.agent}_start_failed`,
      details: { cwd: "project", errno: "ENOENT", syscall: "uv_cwd" },
    });
  } finally {
    process.chdir(previous);
  }
  expect({ probes, launchedIn }).toEqual({ probes: 0, launchedIn: [] });
});
