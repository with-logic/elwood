/** Successful replacement answers detected at the final boundary are not retained (C-PERF-02). */
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { detectCodexCliCapabilities, preflightCodex } from "../../src/codex/preflight.ts";
import { currentCommandRunner, setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { dir, hookTrustBypass, project, useProbeProjects } from "../helpers/preflight-projects.ts";

useProbeProjects();

/** The command seam supplies a successful real replacement read to exercise the outer cache. */
function replacementAnswer(cwd: string, replacement: string): () => void {
  const original = join(dir("elwood-cache-original-"), "kept");
  const probe = currentCommandRunner();
  setCommandRunnerForTests((command, args) => {
    setCommandRunnerForTests(probe);
    renameSync(cwd, original);
    renameSync(replacement, cwd);
    // Model an answer whose directory changed after the child checks. The final stat must
    // still refuse to cache it, independently of the child's earlier refusal checks.
    return probe(command, args, { cwd });
  });
  return () => {
    if (existsSync(original)) {
      renameSync(cwd, replacement);
      renameSync(original, cwd);
    }
  };
}

test.each([
  ["claude", preflightClaude, "2.1.144", "2.1.100"],
  ["codex", preflightCodex, "codex-cli 0.150.0", "codex-cli 0.100.0"],
] as const)("C-PERF-02 a successful %s replacement version is not reused for the restored original", async (agent, preflight, current, old) => {
  const cwd = project(agent, old);
  const restore = replacementAnswer(cwd, project(agent, current));
  try {
    await expect(preflight(cwd, true)).resolves.toBeUndefined();
    restore();
    await expect(preflight(cwd, true)).rejects.toMatchObject({
      code: `${agent}_version_unsupported`,
    });
  } finally {
    restore();
  }
});

test("C-PERF-02 a successful replacement capability answer is not reused for the restored original", async () => {
  const cwd = project("codex", "codex-cli 0.150.0", "no flag");
  const restore = replacementAnswer(cwd, project("codex", "codex-cli 0.150.0", hookTrustBypass));
  try {
    await expect(detectCodexCliCapabilities(cwd)).resolves.toEqual({
      supportsHookTrustBypass: true,
    });
    restore();
    await expect(detectCodexCliCapabilities(cwd)).resolves.toEqual({
      supportsHookTrustBypass: false,
    });
  } finally {
    restore();
  }
});
