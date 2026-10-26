/**
 * The version cache is per session directory: each directory's `--version` is probed once, in
 * that directory, only the most recently used directories' answers are kept, and an autoupdate
 * invalidates every directory's. Covers PRD §9.2 and C-PERF-02.
 */

import { beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex, resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import {
  cachedVersionRead,
  maxRetainedVersionTail,
  maxSettledPreflightDirectoryResults,
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

/** Answers like current CLIs, recording each probe as `<command> in <cwd>`. */
function recordProbes(updateStatus = 0): string[] {
  const probes: string[] = [];
  setCommandRunnerForTests((_command, args, options) => {
    const command = (args.at(-1) ?? "").split("; ").at(-1) ?? "";
    probes.push(`${command} in ${options?.cwd}`);
    if (command.endsWith(" update")) return { status: updateStatus, stdout: "", stderr: "" };
    const codex = command.startsWith("codex");
    return { status: 0, stdout: codex ? "codex-cli 0.132.0" : "2.1.144", stderr: "" };
  });
  return probes;
}

test("C-PERF-02 the caches keep 32 directories and 65,536 code units of each stream", () => {
  expect(maxSettledPreflightDirectoryResults).toBe(32);
  expect(maxRetainedVersionTail).toBe(65_536);
});

test("C-PERF-02 each directory's --version is probed once, in that directory", async () => {
  const probes = recordProbes();
  await Promise.all([preflightClaude("/one"), preflightClaude("/one")]);
  await preflightClaude("/two");
  await preflightClaude("/one", { strictVersionCheck: true });
  expect(probes).toEqual(["claude --version in /one", "claude --version in /two"]);
});

test("C-PERF-02 only the most recently used directories' versions are kept", async () => {
  const probes = recordProbes();
  const dirs = Array.from({ length: maxSettledPreflightDirectoryResults + 1 }, (_, i) => `/d${i}`);
  for (const cwd of dirs) await preflightClaude(cwd);
  await preflightClaude("/d1"); // still kept
  await preflightClaude("/d0"); // the least recently used was dropped
  expect(probes).toHaveLength(dirs.length + 1);
  expect(probes.at(-1)).toBe("claude --version in /d0");
});

test("C-PERF-02 a kept --version read holds only the end of a long output", async () => {
  const noise = "startup noise\n".repeat(100_000);
  let reads = 0;
  const read = () => {
    reads += 1;
    return Promise.resolve({ status: 0, stdout: `${noise}2.1.144\n`, stderr: noise });
  };
  const first = await cachedVersionRead("claude", "/long", read);
  const again = await cachedVersionRead("claude", "/long", read);
  for (const result of [first, again]) {
    expect(result.stdout).toHaveLength(maxRetainedVersionTail);
    expect(result.stdout.endsWith("2.1.144\n")).toBe(true);
    expect(result.stderr).toHaveLength(maxRetainedVersionTail);
  }
  expect(reads).toBe(1);
});

const attempts = [
  { attempt: "succeeds", updateStatus: 0, peer: false, updates: ["claude update", "codex update"] },
  { attempt: "fails", updateStatus: 1, peer: false, updates: ["claude update", "codex update"] },
  { attempt: "is a peer's", updateStatus: 0, peer: true, updates: [] },
];

test.each(
  attempts,
)("C-PERF-02 an update that $attempt runs in its start's directory and invalidates every directory", async ({
  updateStatus,
  peer,
  updates,
}) => {
  const probes = recordProbes(updateStatus);
  if (peer) setUpdateCoordinatorForTests(() => Promise.resolve());
  for (const cwd of ["/one", "/two"]) {
    await preflightClaude(cwd);
    await preflightCodex(cwd);
  }
  probes.length = 0;
  await preflightClaude("/one", { autoupdate: true });
  await preflightCodex("/one", { autoupdate: true });
  await preflightClaude("/two");
  await preflightCodex("/two");
  expect(probes.filter((probe) => probe.includes("update"))).toEqual(
    updates.map((update) => `${update} in /one`),
  );
  expect(probes.filter((probe) => probe.includes("--version"))).toEqual([
    "claude --version in /one",
    "codex --version in /one",
    "claude --version in /two",
    "codex --version in /two",
  ]);
});

test.each([
  ["claude", preflightClaude],
  ["codex", preflightCodex],
] as const)("C-LIFE-11 a failed shared %s update's warning names the directory it ran in", async (_agent, preflight) => {
  recordProbes(1);
  for (const cwd of ["/one", "/two"]) {
    await expect(preflight(cwd, { autoupdate: true })).resolves.toMatchObject({
      code: "agent_update_failed",
      updateCwd: "/one",
    });
  }
});

test("C-PERF-02 a kept tail does not start with half of a surrogate pair", async () => {
  // Pairs at even offsets, so the 65,536-unit tail of 80,001 units starts on a pair's second half.
  const stdout = `${"\u{1F600}".repeat(40_000)}x`;
  const read = () => Promise.resolve({ status: 0, stdout, stderr: "" });
  const kept = await cachedVersionRead("claude", "/emoji", read);
  expect(kept.stdout).toHaveLength(maxRetainedVersionTail - 1);
  expect(kept.stdout.codePointAt(0)).toBe(0x1f600);
});
