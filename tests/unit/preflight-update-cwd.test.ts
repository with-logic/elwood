/**
 * A best-effort update runs once per process, in the launch directory of the start or resume
 * that triggers it, and every launch then checks the version its own directory resolves. A
 * failed update's warning names the directory the update command ran in, and only when one ran
 * here. Covers PRD §9.2, C-PTY-08, and C-LIFE-11.
 */

import { beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex, resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import { elwoodError } from "../../src/core/errors.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
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
)("C-LIFE-11 a %s update skipped for a peer's names no directory, since none ran here", async (agent, preflight, versions) => {
  const probes = recordProbes(versions);
  setUpdateCoordinatorForTests(() =>
    Promise.reject(
      elwoodError(`${agent}_update_failed`, "Another updater has not finished.", {
        updateReason: "active_owner",
      }),
    ),
  );
  const warning = await preflight("/one", false, true);
  expect(warning).toMatchObject({ errorCode: "update_active" });
  expect(warning).not.toHaveProperty("updateCwd");
  expect(probes.filter((probe) => probe.includes(" update "))).toEqual([]);
});
