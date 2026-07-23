/**
 * Regression (PRD §8.1): a RELATIVE stateDir is resolved to absolute at the start
 * boundary BEFORE the awaited preflight, so a cwd change that lands DURING preflight
 * cannot repoint any derived path. We drive the change from inside the command runner
 * the preflight awaits — the exact interleaving the resolve-before-await guards — for
 * both adapters, then assert the session dir sits at the ORIGINAL cwd, not the new one.
 */

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import * as claudeHelpers from "../claude/helpers.ts";
import * as codexHelpers from "../codex/helpers.ts";

let previousCwd: string | undefined;

afterEach(() => {
  claudeHelpers.resetFakes();
  codexHelpers.resetFakes();
  if (previousCwd) process.chdir(previousCwd);
  previousCwd = undefined;
});

/** A command runner that chdir's away the FIRST time preflight probes it. */
function chdirDuringPreflight(elsewhere: string, version: string) {
  let moved = false;
  return () => {
    if (!moved) {
      moved = true;
      process.chdir(elsewhere);
    }
    return { status: 0, stdout: version, stderr: "" };
  };
}

describe("relative stateDir survives a cwd change during preflight", () => {
  test("Claude: the session dir binds under the original cwd, not the mid-preflight one", async () => {
    const origin = realpathSync(claudeHelpers.tempDir());
    const elsewhere = realpathSync(claudeHelpers.tempDir());
    claudeHelpers.installFakes();
    setCommandRunnerForTests(chdirDuringPreflight(elsewhere, "2.1.144\n"));
    previousCwd = process.cwd();
    process.chdir(origin);
    const session = await startClaude({ cwd: origin, stateDir: ".elwood" });
    const sessions = join(origin, ".elwood", "sessions", session.elwoodSessionId);
    expect(existsSync(sessions)).toBe(true);
    expect(existsSync(join(elsewhere, ".elwood"))).toBe(false);
    await session.teardown();
  });

  test("Codex: the session dir binds under the original cwd, not the mid-preflight one", async () => {
    const origin = realpathSync(codexHelpers.tempDir());
    const elsewhere = realpathSync(codexHelpers.tempDir());
    codexHelpers.installFakes();
    setCommandRunnerForTests(chdirDuringPreflight(elsewhere, "unknown build"));
    previousCwd = process.cwd();
    process.chdir(origin);
    const session = await startCodex({ cwd: origin, stateDir: ".elwood" });
    const sessions = join(origin, ".elwood", "sessions", session.elwoodSessionId);
    expect(existsSync(sessions)).toBe(true);
    expect(existsSync(join(elsewhere, ".elwood"))).toBe(false);
    await session.teardown();
  });
});
