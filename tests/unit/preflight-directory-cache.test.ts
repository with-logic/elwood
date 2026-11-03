/** Workspace identity, bounded retention and update invalidation (PRD §9.2, C-PERF-02). */
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import {
  detectCodexCliCapabilities,
  preflightCodex,
  resetCodexPreflightCacheForTests,
} from "../../src/codex/preflight.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import {
  cachedVersionRead,
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

const cap = 65536;
const result = (stdout = "codex-cli 0.150.0", stderr = "") => ({ status: 0, stdout, stderr });
beforeEach(() => {
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
  resetAutoupdateForTests();
  setUpdateCoordinatorForTests((_adapter, run) => run());
  setPlatformForTests("darwin");
});

test.each([
  "version",
  "capability",
] as const)("C-PERF-02 %s shares per directory and retains only 32 successful LRU entries", async (kind) => {
  const dirs = Array.from({ length: 33 }, () => tempDir("elwood-cache-bound-"));
  const first = dirs[0]!;
  const retained = dirs[1]!;
  const last = dirs[32]!;
  const read = vi.fn(async () => result());
  setCommandRunnerForTests(read);
  const at = (cwd: string) =>
    kind === "version" ? cachedVersionRead("codex", read, cwd) : detectCodexCliCapabilities(cwd);
  await Promise.all([at(first), at(first), at(first)]);
  expect(read).toHaveBeenCalledTimes(1);
  for (const cwd of dirs.slice(1)) await at(cwd);
  await at(retained);
  await at(last);
  expect(read).toHaveBeenCalledTimes(33);
  await at(first);
  expect(read).toHaveBeenCalledTimes(34);
});

test.each([
  "stdout",
  "stderr",
] as const)("C-PERF-02 %s retention counts UTF-16 units without truncating output", async (stream) => {
  const cwd = tempDir("elwood-cache-text-");
  for (const text of ["x".repeat(cap), "😀".repeat(cap / 2), "x".repeat(cap + 1)]) {
    resetPreflightCacheForTests();
    const value = { ...result(), [stream]: text };
    const read = vi.fn(async () => value);
    expect(await cachedVersionRead("claude", read, cwd)).toEqual(value);
    expect(await cachedVersionRead("claude", read, cwd)).toEqual(value);
    expect(read).toHaveBeenCalledTimes(text.length > cap ? 2 : 1);
  }
});

test.each([
  "version",
  "capability",
] as const)("C-PERF-02 %s does not reuse a replacement directory's predecessor", async (kind) => {
  const root = tempDir("elwood-cache-replacement-");
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const read = vi.fn(async () => result());
  setCommandRunnerForTests(read);
  const at = () =>
    kind === "version" ? cachedVersionRead("codex", read, cwd) : detectCodexCliCapabilities(cwd);
  await at();
  renameSync(cwd, join(root, "original"));
  mkdirSync(cwd);
  await at();
  expect(read).toHaveBeenCalledTimes(2);
});

test.each([
  "success",
  "failed",
  "peer",
] as const)("C-LIFE-11 %s update invalidates all directory versions and capabilities", async (outcome) => {
  const dirs = [tempDir("elwood-cache-update-a-"), tempDir("elwood-cache-update-b-")];
  const runner = vi.fn((_shell: string, args: readonly string[]) =>
    args.join(" ").includes("codex update") && outcome === "failed"
      ? { status: 1, stdout: "", stderr: "partial update" }
      : result(),
  );
  setCommandRunnerForTests(runner);
  for (const cwd of dirs) {
    await preflightCodex(false, false, cwd);
    await detectCodexCliCapabilities(cwd);
  }
  if (outcome === "peer") setUpdateCoordinatorForTests(async () => {});
  await preflightCodex(false, true, dirs[0]);
  for (const cwd of dirs) {
    await preflightCodex(false, false, cwd);
    await detectCodexCliCapabilities(cwd);
  }
  expect(runner.mock.calls.filter(([, args]) => args.join(" ").includes("--version"))).toHaveLength(
    4,
  );
  expect(runner.mock.calls.filter(([, args]) => args.join(" ").includes("--help"))).toHaveLength(4);
});
