/**
 * A best-effort update runs once per process, in the launch directory of the start or resume
 * that triggers it, and every launch then checks the version its own directory resolves. A
 * failed update's warning names the directory the update command ran in, and only when one ran
 * here. Covers PRD §9.2, C-PTY-08, and C-LIFE-11.
 */

import { beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex, resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import {
  currentCommandRunner,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";

beforeEach(() => {
  resetAutoupdateForTests();
  setUpdateCoordinatorForTests((_adapter, update) => update());
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
  setPlatformForTests("darwin");
});

const agents = [
  ["claude", preflightClaude, { "/one": "2.1.144", "/two": "2.1.150" }],
  ["codex", preflightCodex, { "/one": "codex-cli 0.132.0", "/two": "codex-cli 0.140.0" }],
] as const;

/** Answers each directory's own version and fails every update, recording `<command> in <cwd>`. */
function recordProbes(versions: Readonly<Record<string, string>>): string[] {
  const probes: string[] = [];
  setCommandRunnerForTests((_command, args, options) => {
    const command = /exec ([^;]*) >"\$ELWOOD_PROBE_OUTPUT/.exec(args.at(-1) ?? "")?.[1] ?? "";
    probes.push(`${command} in ${options?.cwd}`);
    if (command.endsWith(" update")) return { status: 1, stdout: "", stderr: "offline\n" };
    return { status: 0, stdout: versions[options?.cwd ?? ""] ?? "", stderr: "" };
  });
  return probes;
}

test.each(
  agents,
)("C-LIFE-11 a failed shared %s update names its directory, and each launch checks its own version", async (agent, preflight, versions) => {
  const probes = recordProbes(versions);
  const one = await preflight("/one", false, true);
  const two = await preflight("/two", false, true);
  expect(probes.filter((probe) => probe.includes(" update "))).toEqual([`${agent} update in /one`]);
  expect(one).toMatchObject({ raw: "offline\n", updateCwd: "/one" });
  // `/two` shares `/one`'s failed attempt but runs, and reports, the CLI its own directory has.
  const installed = versions["/two"].replace("codex-cli ", "");
  expect(two).toMatchObject({ installedVersion: installed, updateCwd: "/one" });
  expect(probes.at(-1)).toBe(`${agent} --version in /two`);
});

test.each(
  agents,
)("C-LIFE-11 a %s update whose CLI check fails runs no update command and sends no warning", async (agent, preflight, versions) => {
  const probes = recordProbes(versions);
  const answer = currentCommandRunner();
  setCommandRunnerForTests(() => {
    setCommandRunnerForTests(answer); // only the check before the update fails
    probes.push(`${agent} --version in /one`);
    return { status: 1, stdout: "", stderr: "busy\n" };
  });
  await expect(preflight("/one", false, true)).resolves.toBeUndefined();
  // The failed check, then the launch's own version read: no update between them.
  expect(probes).toEqual([`${agent} --version in /one`, `${agent} --version in /one`]);
});

test.each(
  agents,
)("C-LIFE-11 a %s update whose login shell fails before running it names no directory", async (agent, preflight, versions) => {
  const probes = recordProbes(versions);
  const answer = currentCommandRunner();
  setCommandRunnerForTests((command, args, options) => {
    if (!args.at(-1)?.includes(`exec ${agent} update`)) return answer(command, args, options);
    probes.push(`${agent} update in /one`);
    const error = { message: "the login shell did not start", code: "ETIMEDOUT" } as const;
    return { status: null, stdout: "", stderr: "", error: { ...error, phase: "login_shell" } };
  });
  const warning = await preflight("/one", false, true);
  expect(warning).toMatchObject({ errorCode: "login_shell_failed" });
  expect(warning).not.toHaveProperty("updateCwd");
  expect(probes.filter((probe) => probe.includes(" update "))).toEqual([`${agent} update in /one`]);
});
