/** Preflight retains the original launch directory identity (PRD §5.1, C-API-61). */
import { existsSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import {
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { resumableStateDir } from "../helpers/session-state.ts";
import { tempDir } from "../helpers/tmp.ts";

const agents = [
  ["claude", startClaude, resumeClaude],
  ["codex", startCodex, resumeCodex],
] as const;

beforeEach(() => setPlatformForTests("darwin"));
afterEach(() => {
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
});

for (const kind of ["start", "resume"] as const) {
  test.each(
    agents,
  )(`C-API-61 ${kind} of %s retains its identity across preflight`, async (agent, start, resume) => {
    const cwd = realpathSync(tempDir("elwood-pty-guard-first-"));
    const original = join(tempDir("elwood-pty-guard-held-"), "kept");
    const replacement = tempDir("elwood-pty-guard-new-");
    const stateDir = kind === "resume" ? resumableStateDir(agent, cwd, "guard-resume") : undefined;
    let swapped = false;
    let ptys = 0;
    setCommandRunnerForTests(() => {
      if (!swapped) {
        swapped = true;
        renameSync(cwd, original);
        renameSync(replacement, cwd);
      }
      return { status: 0, stdout: "2.1.144 (Claude Code) codex-cli 0.150.0", stderr: "" };
    });
    setPtyFactoryForTests(() => {
      ptys += 1;
      throw new Error("must not spawn");
    });
    try {
      const launch =
        stateDir === undefined
          ? start({ cwd })
          : resume({ stateDir, elwoodSessionId: "guard-resume" });
      await expect(launch).rejects.toMatchObject({
        code: `${agent}_start_failed`,
        details: { cwd },
      });
      expect(ptys).toBe(0);
      expect(existsSync(join(cwd, ".elwood"))).toBe(false);
    } finally {
      if (existsSync(original)) {
        renameSync(cwd, replacement);
        renameSync(original, cwd);
      }
    }
  });
}
