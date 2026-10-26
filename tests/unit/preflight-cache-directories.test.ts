/**
 * The preflight caches are per launch directory: each directory's `--version`, and Codex's
 * `--help`, is probed once, in that directory, only the most recently used directories' answers
 * are kept, an answer is kept only for a directory it can identify and a version read only when
 * it is small, and an autoupdate invalidates every directory's. Covers PRD §9.2 and C-PERF-02.
 */

import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import {
  detectCodexCliCapabilities,
  preflightCodex,
  resetCodexPreflightCacheForTests,
} from "../../src/codex/preflight.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import {
  cachedVersionRead,
  maxKeptVersionStreamCodeUnits,
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

/** Real directories, which the caches can identify, by the names the probes record. */
const names = new Map<string, string>();
function directory(name: string): string {
  const path = tempDir(`elwood-cache-${name}-`);
  names.set(path, name);
  return path;
}

/** Answers like current CLIs, or as `versions` gives per name; records `<command> in <name>`. */
function recordProbes(updateStatus = 0, versions: Readonly<Record<string, string>> = {}) {
  const probes: string[] = [];
  setCommandRunnerForTests((_command, args, options) => {
    const command = /exec ([^;]*) >"\$ELWOOD_PROBE_OUTPUT/.exec(args.at(-1) ?? "")?.[1] ?? "";
    const name = names.get(options?.cwd ?? "") ?? options?.cwd;
    probes.push(`${command} in ${name}`);
    if (command.endsWith(" update")) return { status: updateStatus, stdout: "", stderr: "" };
    const current = command.startsWith("codex") ? "codex-cli 0.132.0" : "2.1.144";
    return { status: 0, stdout: versions[name ?? ""] ?? current, stderr: "" };
  });
  return probes;
}

test("C-PERF-02 the caches keep 32 directories, and version reads of 65,536 code units a stream", () => {
  expect(maxSettledPreflightDirectoryResults).toBe(32);
  expect(maxKeptVersionStreamCodeUnits).toBe(65_536);
});

test("C-PERF-02 each directory's --version and --help are probed once, in that directory", async () => {
  const probes = recordProbes();
  const [one, two] = [directory("one"), directory("two")];
  await Promise.all([preflightClaude(one, false), preflightClaude(one, false)]);
  await preflightClaude(two, false);
  await preflightClaude(one, true);
  await Promise.all([detectCodexCliCapabilities(one), detectCodexCliCapabilities(one)]);
  await detectCodexCliCapabilities(two);
  await detectCodexCliCapabilities(one);
  expect(probes).toEqual([
    "claude --version in one",
    "claude --version in two",
    "codex --help in one",
    "codex --help in two",
  ]);
});

test.each([
  ["claude --version", (cwd: string) => preflightClaude(cwd, false)],
  ["codex --version", (cwd: string) => preflightCodex(cwd, false)],
  ["codex --help", detectCodexCliCapabilities],
] as const)("C-PERF-02 only the most recently used directories' %s answers are kept", async (probe, read) => {
  const probes = recordProbes();
  const dirs = Array.from({ length: maxSettledPreflightDirectoryResults + 1 }, (_, i) =>
    directory(`d${i}`),
  );
  for (const cwd of dirs) await read(cwd);
  await read(dirs[1] as string); // still kept
  await read(dirs[0] as string); // the least recently used was dropped
  expect(probes).toHaveLength(dirs.length + 1);
  expect(probes.at(-1)).toBe(`${probe} in d0`);
});

test("C-PERF-02 a symlink to a probed directory is probed as its own path", async () => {
  // The same directory, but a path-dependent tool manager can resolve another CLI through it.
  const real = directory("real");
  const alias = join(directory("parent"), "alias");
  symlinkSync(real, alias);
  const probes = recordProbes(0, { [alias]: "2.1.100" });
  await expect(preflightClaude(real, true)).resolves.toBeUndefined();
  await expect(preflightClaude(alias, true)).rejects.toMatchObject(oldClaude);
  expect(probes).toEqual(["claude --version in real", `claude --version in ${alias}`]);
});

test("C-PERF-02 an answer for a directory that can't be identified is not kept", async () => {
  let reads = 0;
  const read = () => {
    reads += 1;
    return Promise.resolve({ status: 0, stdout: "2.1.144", stderr: "" });
  };
  const missing = join(directory("parent"), "missing");
  await cachedVersionRead("claude", missing, read);
  await cachedVersionRead("claude", missing, read);
  expect(reads).toBe(2);
});

test.each([
  ["stdout", "kept", maxKeptVersionStreamCodeUnits, 1],
  ["stdout", "not kept", maxKeptVersionStreamCodeUnits + 1, 2],
  ["stderr", "not kept", maxKeptVersionStreamCodeUnits + 1, 2],
] as const)("C-PERF-02 a --version read whose %s is that long is %s, and every caller gets all of it", async (stream, _kept, length, expectedReads) => {
  const output = `2.1.144 ${"x".repeat(length - 8)}`;
  let reads = 0;
  const read = () => {
    reads += 1;
    const quiet = { status: 0, stdout: "2.1.144", stderr: "" };
    return Promise.resolve({ ...quiet, [stream]: output });
  };
  const cwd = directory("long");
  const results = [await cachedVersionRead("claude", cwd, read)];
  results.push(await cachedVersionRead("claude", cwd, read));
  for (const result of results) expect(result[stream]).toBe(output);
  expect(reads).toBe(expectedReads);
});

test.each([
  ["succeeds", 0],
  ["fails", 1],
])("C-PERF-02 an update that %s runs in its launch's directory and invalidates every directory", async (_, updateStatus) => {
  const probes = recordProbes(updateStatus);
  expect(await readsAroundAnUpdate(probes)).toEqual(everyDirectoryReadAgain);
  expect(probes.filter((probe) => probe.includes("update"))).toEqual([
    "claude update in one",
    "codex update in one",
  ]);
});

test("C-PERF-02 a peer's update, which runs nothing here, still invalidates every directory", async () => {
  const probes = recordProbes();
  setUpdateCoordinatorForTests(() => Promise.resolve());
  expect(await readsAroundAnUpdate(probes)).toEqual(everyDirectoryReadAgain);
  expect(probes.filter((probe) => probe.includes("update"))).toEqual([]);
});

const everyDirectoryReadAgain = [
  "claude --version in one",
  "codex --version in one",
  "codex --help in one",
  "claude --version in two",
  "codex --version in two",
  "codex --help in two",
];

/** The reads, not the updates, of reading `one` and `two` again after an autoupdate from `one`. */
async function readsAroundAnUpdate(probes: string[]): Promise<string[]> {
  const [one, two] = [directory("one"), directory("two")];
  for (const cwd of [one, two]) {
    await preflightClaude(cwd, false);
    await preflightCodex(cwd, false);
    await detectCodexCliCapabilities(cwd);
  }
  probes.length = 0;
  for (const cwd of [one, two]) {
    await preflightClaude(cwd, false, cwd === one);
    await preflightCodex(cwd, false, cwd === one);
    await detectCodexCliCapabilities(cwd);
  }
  return probes.filter((probe) => !probe.includes("update"));
}
