/**
 * On start, the directory the session launches in answers its preflight and Codex's capability
 * check, never Elwood's own directory, and a probe whose directory goes fails as that directory,
 * keeping the probe's own failure as the cause, not as a missing CLI. The one shared update runs
 * in the directory of the launch that triggers it, and a launch whose directory has no CLI
 * triggers none. The probes run for real through a stand-in login shell. Covers PRD §4.2, §9.2,
 * C-PTY-08, C-PERF-04, C-LIFE-11, and C-API-61.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import * as shell from "../../src/runtime/shell.ts";
import {
  bypassByDirectory,
  dir,
  directoryLossCases,
  hookTrustBypass,
  lostDirectory,
  oldClaude,
  oldCodex,
  project,
  removeWhenProbed,
  useProbeProjects,
} from "../helpers/preflight-projects.ts";

const launches = useProbeProjects();
const agents = [
  ["codex", startCodex, preflightCodex, "codex-cli 0.150.0"],
  ["claude", startClaude, preflightClaude, "2.1.144 (Claude Code)"],
] as const;

test.each([
  ["codex", startCodex, "codex-cli 0.150.0", "codex-cli 0.100.0", oldCodex],
  ["claude", startClaude, "2.1.144 (Claude Code)", "2.1.100 (Claude Code)", oldClaude],
] as const)("C-PTY-08 C-PERF-02 a %s start checks the CLI its own session directory resolves", async (agent, start, current, outdated, old) => {
  // The read kept for another directory must not answer for this one.
  await start({ cwd: project(agent, current) }).catch(() => undefined); // no PTY here
  const cwd = project(agent, outdated);
  await expect(start({ cwd, strictVersionCheck: true })).rejects.toMatchObject(old);
});

describe.each(directoryLossCases)("a directory $how", ({ remade, message, errno }) => {
  test.each(
    agents,
  )("C-PTY-08 C-API-61 a %s start whose directory goes as its CLI is probed fails as that, with the probe's cause", async (agent, start, _preflight, version) => {
    const cwd = project(agent, version);
    removeWhenProbed(cwd, remade ? dir("elwood-preflight-replacement-") : undefined);
    await expect(start({ cwd })).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      message,
      details: lostDirectory(cwd, errno),
    });
    expect(launches).toEqual([]);
  });
});

test("C-PTY-08 a login shell that cannot start, in a directory that exists, is a missing CLI", async () => {
  vi.spyOn(shell, "userShell").mockReturnValue(join(dir("elwood-preflight-noshell-"), "absent"));
  const cwd = dir("elwood-preflight-session-");
  const missing = { details: { cause: expect.stringMatching(/ENOENT$/), errno: "ENOENT" } };
  await expect(preflightCodex(cwd, false)).rejects.toMatchObject({
    code: "codex_not_found",
    ...missing,
  });
  await expect(preflightClaude(cwd, false)).rejects.toMatchObject({
    code: "claude_not_found",
    ...missing,
  });
});

test.each(
  agents,
)("C-API-61 a %s start in a directory removed after its answer was cached fails without recreating it", async (agent, start, preflight, version) => {
  const cwd = project(agent, version);
  await preflight(cwd, false); // keeps this directory's answer
  rmSync(cwd, { recursive: true });
  await expect(start({ cwd })).rejects.toMatchObject({
    code: `${agent}_start_failed`,
    details: { cwd, errno: "ENOENT" },
  });
  expect(existsSync(cwd), "the directory must not be recreated").toBe(false);
});

test.each([
  ["codex", startCodex, "codex-cli 0.150.0"],
  ["claude", startClaude, "2.1.144 (Claude Code)"],
] as const)("C-PTY-08 a %s start's best-effort update runs in its session directory", async (agent, start, version) => {
  const cwd = project(agent, version);
  await start({ cwd, autoupdate: true }).catch(() => undefined); // no PTY here
  expect(readFileSync(join(cwd, "updated-in"), "utf8")).toBe(`${cwd}\n`);
});

test("C-PTY-08 startCodex launches with the capabilities of the codex in its directory", async () => {
  const projects = [hookTrustBypass, "no such flag"].map((help) =>
    project("codex", "codex-cli 0.150.0", help),
  );
  for (const cwd of projects) {
    await expect(startCodex({ cwd })).rejects.toMatchObject({ code: "pty_start_failed" });
  }
  expect(bypassByDirectory(launches)).toEqual([
    [projects[0], true],
    [projects[1], false],
  ]);
});

const preflights = [
  ["codex", preflightCodex, "codex-cli 0.150.0", "codex-cli 0.100.0", oldCodex],
  ["claude", preflightClaude, "2.1.144 (Claude Code)", "2.1.100 (Claude Code)", oldClaude],
] as const;

test.each(
  preflights,
)("C-PTY-08 C-PERF-04 concurrent %s launches in two directories share one update, run in the first, and each check their own CLI", async (agent, preflight, current, outdated, old) => {
  const [first, second] = [project(agent, current), project(agent, outdated)];
  const checked = await Promise.allSettled([
    preflight(first, true, true),
    preflight(second, true, true),
  ]);
  expect(checked).toMatchObject([
    { status: "fulfilled", value: undefined },
    { status: "rejected", reason: old },
  ]);
  expect(readFileSync(join(first, "updated-in"), "utf8")).toBe(`${first}\n`);
  expect(existsSync(join(second, "updated-in"))).toBe(false);
});

test.each(
  preflights,
)("C-PTY-08 C-LIFE-11 a %s launch whose directory has no CLI runs no update; a launch that shared it updates in its own, without a warning", async (agent, preflight, current) => {
  const [bare, other] = [dir("elwood-preflight-session-"), project(agent, current)];
  const checked = await Promise.allSettled([
    preflight(bare, false, true),
    preflight(other, false, true),
  ]);
  expect(checked).toMatchObject([
    { status: "rejected", reason: { code: `${agent}_not_found` } },
    { status: "fulfilled", value: undefined },
  ]);
  expect(readFileSync(join(other, "updated-in"), "utf8")).toBe(`${other}\n`);
});
