/**
 * A launch directory replaced around preflight: the probes' answers describe the directory they
 * ran in, so a start whose directory is replaced while a best-effort update falls back fails as
 * that directory, and a directory replaced after its answer was cached is probed again. The
 * probes run for real through a stand-in login shell. Covers PRD §4.2, §9.2, C-API-61, and
 * C-PERF-02.
 */

import { renameSync, rmSync } from "node:fs";
import { beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import { setUpdateCoordinatorForTests } from "../../src/runtime/update/once.ts";
import {
  oldClaude,
  oldCodex,
  project,
  removeWhenProbed,
  useProbeProjects,
} from "../helpers/preflight-projects.ts";

const launches = useProbeProjects();
beforeEach(() => setUpdateCoordinatorForTests((_adapter, update) => update()));

const agents = [
  ["codex", startCodex, preflightCodex, "codex-cli 0.150.0", oldCodex, "codex-cli 0.100.0"],
  ["claude", startClaude, preflightClaude, "2.1.144 (Claude Code)", oldClaude, "2.1.100"],
] as const;

test.each(
  agents,
)("C-API-61 a %s start whose directory is replaced while its update falls back fails as that", async (agent, start, _preflight, version) => {
  const cwd = project(agent, version);
  // The update's own version read finds the directory gone, so the update fails and preflight
  // reads the version again, from the replacement, which passes.
  removeWhenProbed(cwd, project(agent, version));
  await expect(start({ cwd, autoupdate: true })).rejects.toMatchObject({
    code: `${agent}_start_failed`,
    message: "The working directory (`cwd`) was replaced by another directory.",
    details: { cwd },
  });
  expect(launches).toEqual([]);
});

test.each(
  agents,
)("C-PERF-02 a %s directory replaced after its answer was cached is probed again", async (agent, start, preflight, version, old, oldVersion) => {
  const cwd = project(agent, version);
  await preflight(cwd); // keeps this directory's answer
  const replacement = project(agent, oldVersion); // made while `cwd` exists: a new directory
  rmSync(cwd, { recursive: true });
  renameSync(replacement, cwd);
  await expect(start({ cwd, strictVersionCheck: true })).rejects.toMatchObject(old);
});
