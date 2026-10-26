/**
 * On start, the directory the session launches in answers its preflight, never Elwood's own
 * directory, and a probe whose directory is gone fails as that, not as a missing CLI, even when
 * it was made again or its answer was cached. The
 * probes run for real through a stand-in login shell. Covers PRD §4.2, §9.2, C-PTY-08, and
 * C-API-61.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import * as shell from "../../src/runtime/shell.ts";
import {
  codexHookTrustBypassFlag,
  dir,
  directoryLossCases,
  oldClaude,
  oldCodex,
  project,
  removeWhenProbed,
  useProbeProjects,
} from "../helpers/preflight-projects.ts";

const launches = useProbeProjects();

test("C-PTY-08 startCodex checks the codex its session directory resolves", async () => {
  const cwd = project("codex", "codex-cli 0.100.0");
  await expect(startCodex({ cwd, strictVersionCheck: true })).rejects.toMatchObject(oldCodex);
});

test("C-PTY-08 startClaude checks the claude its session directory resolves", async () => {
  const cwd = project("claude", "2.1.100 (Claude Code)");
  await expect(startClaude({ cwd, strictVersionCheck: true })).rejects.toMatchObject(oldClaude);
});

describe.each(directoryLossCases)("a directory $how", ({ remade, message, errno }) => {
  test.each([
    ["codex", startCodex, "codex-cli 0.150.0"],
    ["claude", startClaude, "2.1.144 (Claude Code)"],
  ] as const)("C-PTY-08 C-API-61 a %s start whose directory goes as its CLI is probed fails as that, not as a missing CLI", async (agent, start, version) => {
    const cwd = project(agent, version);
    removeWhenProbed(cwd, remade ? dir("elwood-preflight-replacement-") : undefined);
    await expect(start({ cwd })).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      message,
      details: { cwd, ...errno },
    });
  });
});

test("C-PTY-08 a login shell that cannot start, in a directory that exists, is a missing CLI", async () => {
  vi.spyOn(shell, "userShell").mockReturnValue(join(dir("elwood-preflight-noshell-"), "absent"));
  const cwd = dir("elwood-preflight-session-");
  await expect(preflightCodex(cwd)).rejects.toMatchObject({ code: "codex_not_found" });
  await expect(preflightClaude(cwd)).rejects.toMatchObject({ code: "claude_not_found" });
});

test("C-PTY-08 startCodex launches with the capabilities of its directory's codex", async () => {
  const projects = [codexHookTrustBypassFlag, "no such flag"].map((help) =>
    project("codex", "codex-cli 0.150.0", help),
  );
  for (const cwd of projects) {
    await expect(startCodex({ cwd })).rejects.toMatchObject({ code: "pty_start_failed" });
  }
  expect(launches.map(({ command }) => command.includes(codexHookTrustBypassFlag))).toEqual([
    true,
    false,
  ]);
  expect(launches.map(({ cwd }) => cwd)).toEqual(projects);
});

test.each([
  ["codex", startCodex, preflightCodex, "codex-cli 0.150.0"],
  ["claude", startClaude, preflightClaude, "2.1.144 (Claude Code)"],
] as const)("C-PERF-02 C-API-61 a %s start in a directory removed after its answer was cached fails without recreating it", async (agent, start, preflight, version) => {
  const cwd = project(agent, version);
  await preflight(cwd); // keeps this directory's answer
  rmSync(cwd, { recursive: true });
  await expect(start({ cwd })).rejects.toMatchObject({
    code: `${agent}_start_failed`,
    details: { cwd, errno: "ENOENT" },
  });
  expect(existsSync(cwd), "the directory must not be recreated").toBe(false);
});
