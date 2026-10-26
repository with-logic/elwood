/**
 * The version cache is per launch directory: each directory's `--version` is probed once, in
 * that directory, only the most recently used directories' answers are kept, each stream is cut
 * to its tail, and an autoupdate invalidates every directory's. Covers PRD §9.2 and C-PERF-02.
 */

import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex, resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import {
  cachedVersionRead,
  maxRetainedVersionTailCodeUnits,
  maxSettledPreflightDirectoryResults,
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { oldClaude } from "../helpers/preflight-projects.ts";
import { tempDir } from "../helpers/tmp.ts";

beforeEach(() => {
  resetAutoupdateForTests();
  setUpdateCoordinatorForTests((_adapter, update) => update());
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
  setPlatformForTests("darwin");
});

/** Answers like current CLIs, or as `versions` gives per directory; records `<command> in <cwd>`. */
function recordProbes(updateStatus = 0, versions: Readonly<Record<string, string>> = {}) {
  const probes: string[] = [];
  setCommandRunnerForTests((_command, args, options) => {
    const command = /exec ([^;]*) >"\$ELWOOD_PROBE_OUTPUT/.exec(args.at(-1) ?? "")?.[1] ?? "";
    probes.push(`${command} in ${options?.cwd}`);
    if (command.endsWith(" update")) return { status: updateStatus, stdout: "", stderr: "" };
    const current = command.startsWith("codex") ? "codex-cli 0.132.0" : "2.1.144";
    return { status: 0, stdout: versions[options?.cwd ?? ""] ?? current, stderr: "" };
  });
  return probes;
}

test("C-PERF-02 the caches keep 32 directories and 65,536 code units of each stream", () => {
  expect(maxSettledPreflightDirectoryResults).toBe(32);
  expect(maxRetainedVersionTailCodeUnits).toBe(65_536);
});

test("C-PERF-02 each directory's --version is probed once, in that directory", async () => {
  const probes = recordProbes();
  await Promise.all([preflightClaude("/one", false), preflightClaude("/one", false)]);
  await preflightClaude("/two", false);
  await preflightClaude("/one", true);
  expect(probes).toEqual(["claude --version in /one", "claude --version in /two"]);
});

test("C-PERF-02 only the most recently used directories' versions are kept", async () => {
  const probes = recordProbes();
  const dirs = Array.from({ length: maxSettledPreflightDirectoryResults + 1 }, (_, i) => `/d${i}`);
  for (const cwd of dirs) await preflightClaude(cwd, false);
  await preflightClaude("/d1", false); // still kept
  await preflightClaude("/d0", false); // the least recently used was dropped
  expect(probes).toHaveLength(dirs.length + 1);
  expect(probes.at(-1)).toBe("claude --version in /d0");
});

test("C-PERF-02 a symlink to a probed directory is probed as its own path", async () => {
  // The same directory, but a path-dependent tool manager can resolve another CLI through it.
  const real = tempDir("elwood-version-real-");
  const alias = join(tempDir("elwood-version-alias-"), "alias");
  symlinkSync(real, alias);
  const probes = recordProbes(0, { [alias]: "2.1.100" });
  await expect(preflightClaude(real, true)).resolves.toBeUndefined();
  await expect(preflightClaude(alias, true)).rejects.toMatchObject(oldClaude);
  expect(probes).toEqual([`claude --version in ${real}`, `claude --version in ${alias}`]);
});

test("C-PERF-02 a kept --version read holds only the end of each long stream", async () => {
  const noise = "long output\n".repeat(100_000);
  let reads = 0;
  const read = () => {
    reads += 1;
    return Promise.resolve({ status: 0, stdout: `${noise}2.1.144\n`, stderr: `${noise}last\n` });
  };
  const first = await cachedVersionRead("claude", "/long", read);
  const again = await cachedVersionRead("claude", "/long", read);
  for (const result of [first, again]) {
    expect(result.stdout).toHaveLength(maxRetainedVersionTailCodeUnits);
    expect(result.stdout.endsWith("2.1.144\n")).toBe(true);
    expect(result.stderr).toHaveLength(maxRetainedVersionTailCodeUnits);
    expect(result.stderr.endsWith("long output\nlast\n")).toBe(true);
  }
  expect(reads).toBe(1);
});

test("C-PERF-02 a kept tail does not start with half of a surrogate pair", async () => {
  // Pairs at even offsets, so the 65,536-unit tail of 80,001 units starts on a pair's second half.
  const stdout = `${"\u{1F600}".repeat(40_000)}x`;
  const read = () => Promise.resolve({ status: 0, stdout, stderr: "" });
  const kept = await cachedVersionRead("claude", "/emoji", read);
  expect(kept.stdout).toHaveLength(maxRetainedVersionTailCodeUnits - 1);
  expect(kept.stdout.codePointAt(0)).toBe(0x1f600);
});

test.each([
  ["succeeds", 0],
  ["fails", 1],
])("C-PERF-02 an update that %s runs in its launch's directory and invalidates every directory", async (_, updateStatus) => {
  const probes = recordProbes(updateStatus);
  expect(await versionReadsAroundAnUpdate(probes)).toEqual(everyDirectoryReadAgain);
  expect(probes.filter((probe) => probe.includes("update"))).toEqual([
    "claude update in /one",
    "codex update in /one",
  ]);
});

test("C-PERF-02 a peer's update, which runs nothing here, still invalidates every directory", async () => {
  const probes = recordProbes();
  setUpdateCoordinatorForTests(() => Promise.resolve());
  expect(await versionReadsAroundAnUpdate(probes)).toEqual(everyDirectoryReadAgain);
  expect(probes.filter((probe) => probe.includes("update"))).toEqual([]);
});

const everyDirectoryReadAgain = [
  "claude --version in /one",
  "codex --version in /one",
  "claude --version in /two",
  "codex --version in /two",
];

/** The `--version` probes of reading `/one` and `/two` again after an autoupdate from `/one`. */
async function versionReadsAroundAnUpdate(probes: string[]): Promise<string[]> {
  for (const cwd of ["/one", "/two"]) {
    await preflightClaude(cwd, false);
    await preflightCodex(cwd, false);
  }
  probes.length = 0;
  await preflightClaude("/one", false, true);
  await preflightCodex("/one", false, true);
  await preflightClaude("/two", false);
  await preflightCodex("/two", false);
  return probes.filter((probe) => probe.includes("--version"));
}
