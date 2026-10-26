/**
 * A version or capability answer describes the directory its probe ran in, so the caches never
 * answer one directory with another's: a directory replaced after its answer was kept is probed
 * again, and an answer read while its directory was replaced is not kept for the original. The
 * probes run for real through a stand-in login shell. Covers PRD §9.2 and C-PERF-02.
 */

import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { detectCodexCliCapabilities, preflightCodex } from "../../src/codex/preflight.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import { currentCommandRunner, setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import {
  bypassByDirectory,
  dir,
  hookTrustBypass,
  oldClaude,
  oldCodex,
  project,
  useProbeProjects,
} from "../helpers/preflight-projects.ts";

const launches = useProbeProjects();

const agents = [
  ["codex", startCodex, preflightCodex, "codex-cli 0.150.0", oldCodex, "codex-cli 0.100.0"],
  ["claude", startClaude, preflightClaude, "2.1.144 (Claude Code)", oldClaude, "2.1.100"],
] as const;

test.each(
  agents,
)("C-PERF-02 a %s directory replaced after its answer was kept is probed again", async (agent, start, preflight, version, old, oldVersion) => {
  const cwd = project(agent, version);
  await preflight(cwd, false); // keeps this directory's answer
  const replacement = project(agent, oldVersion); // made while `cwd` exists: a new directory
  rmSync(cwd, { recursive: true });
  renameSync(replacement, cwd);
  await expect(start({ cwd, strictVersionCheck: true })).rejects.toMatchObject(old);
});

test("C-PERF-02 a codex directory replaced after its capabilities were kept is probed again", async () => {
  const cwd = project("codex", "codex-cli 0.150.0", hookTrustBypass);
  await detectCodexCliCapabilities(cwd); // keeps this directory's answer: the flag is supported
  const replacement = project("codex", "codex-cli 0.150.0", "no such flag");
  rmSync(cwd, { recursive: true });
  renameSync(replacement, cwd);
  await expect(startCodex({ cwd })).rejects.toMatchObject({ code: "pty_start_failed" });
  expect(bypassByDirectory(launches)).toEqual([[cwd, false]]);
});

test.each(
  agents,
)("C-PERF-02 a %s answer read while its directory was replaced is not kept for the original", async (agent, _start, preflight, version, old, oldVersion) => {
  const cwd = project(agent, oldVersion);
  const original = join(dir("elwood-preflight-original-"), "original");
  const replacement = project(agent, version);
  swapWhenProbed(cwd, original, replacement);
  await expect(preflight(cwd, true)).resolves.toBeUndefined(); // the replacement's CLI
  renameSync(cwd, replacement);
  renameSync(original, cwd); // the original is back, with its own, older CLI
  await expect(preflight(cwd, true)).rejects.toMatchObject(old);
});

test("C-PERF-02 capabilities read while their directory was replaced are not kept for the original", async () => {
  const cwd = project("codex", "codex-cli 0.150.0", "no such flag");
  const original = join(dir("elwood-preflight-original-"), "original");
  const replacement = project("codex", "codex-cli 0.150.0", hookTrustBypass);
  swapWhenProbed(cwd, original, replacement);
  await expect(detectCodexCliCapabilities(cwd)).resolves.toEqual({ supportsHookTrustBypass: true });
  renameSync(cwd, replacement);
  renameSync(original, cwd); // the original is back, and its codex lacks the flag
  await expect(detectCodexCliCapabilities(cwd)).resolves.toEqual({
    supportsHookTrustBypass: false,
  });
});

/** Once the next read is keyed by `cwd`'s directory, moves it to `original` and `replacement` in. */
function swapWhenProbed(cwd: string, original: string, replacement: string): void {
  const probe = currentCommandRunner();
  setCommandRunnerForTests((command, args, options) => {
    setCommandRunnerForTests(probe);
    renameSync(cwd, original);
    renameSync(replacement, cwd);
    return probe(command, args, options);
  });
}
