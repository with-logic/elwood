/**
 * On start, the directory the session launches in answers its preflight, never Elwood's own
 * directory, and a probe whose directory goes fails as that directory, not as a missing CLI.
 * The probes run for real through a stand-in login shell. Covers PRD §4.2, §9.2, C-PTY-08, and
 * C-API-61.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import {
  oldClaude,
  oldCodex,
  project,
  removeWhenProbed,
  useProbeProjects,
} from "../helpers/preflight-projects.ts";

const launches = useProbeProjects();

test.each([
  ["codex", startCodex, "codex-cli 0.150.0", "codex-cli 0.100.0", oldCodex],
  ["claude", startClaude, "2.1.144 (Claude Code)", "2.1.100 (Claude Code)", oldClaude],
] as const)("C-PTY-08 C-PERF-02 a %s start checks the CLI its own session directory resolves", async (agent, start, current, outdated, old) => {
  // The read kept for another directory must not answer for this one.
  await start({ cwd: project(agent, current) }).catch(() => undefined); // no PTY here
  const cwd = project(agent, outdated);
  await expect(start({ cwd, strictVersionCheck: true })).rejects.toMatchObject(old);
});

test.each([
  ["codex", startCodex, "codex-cli 0.150.0"],
  ["claude", startClaude, "2.1.144 (Claude Code)"],
] as const)("C-PTY-08 C-API-61 a %s start whose directory goes as its CLI is probed fails as that, not as a missing CLI", async (agent, start, version) => {
  const cwd = project(agent, version);
  removeWhenProbed(cwd);
  await expect(start({ cwd })).rejects.toMatchObject({
    code: `${agent}_start_failed`,
    message: "The working directory (`cwd`) is not an existing directory.",
    details: { cwd, errno: "ENOENT" },
  });
  expect(launches).toEqual([]);
});

test.each([
  ["codex", startCodex, "codex-cli 0.150.0"],
  ["claude", startClaude, "2.1.144 (Claude Code)"],
] as const)("C-PTY-08 a %s start's best-effort update runs in its session directory", async (agent, start, version) => {
  const cwd = project(agent, version);
  const cli = `#!/bin/sh\n[ "$1" = update ] && pwd > updated-in\necho '${version}'\n`;
  writeFileSync(join(cwd, "bin", agent), cli);
  await start({ cwd, autoupdate: true }).catch(() => undefined); // no PTY here
  expect(readFileSync(join(cwd, "updated-in"), "utf8")).toBe(`${cwd}\n`);
});
