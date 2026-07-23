/**
 * Regression (PRD §8.1, §8.2): a RELATIVE cwd AND a relative stateDir are both resolved
 * to absolute at the start boundary BEFORE the awaited preflight, so a cwd change that
 * lands DURING preflight cannot split where state is written (and the record's persisted
 * cwd) from where the CLI launches. We drive the change from inside the command runner
 * the preflight awaits — the exact interleaving the resolve-before-await guards — for
 * both adapters, passing `cwd: "."` so the split would actually manifest if unresolved.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
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

function recordedCwd(sessionsRoot: string, id: string): string {
  return JSON.parse(readFileSync(join(sessionsRoot, id, "session.json"), "utf8")).cwd;
}

describe("relative cwd + stateDir survive a cwd change during preflight", () => {
  test("Claude: state, record cwd, and launch all bind to the original cwd", async () => {
    const origin = realpathSync(claudeHelpers.tempDir());
    const elsewhere = realpathSync(claudeHelpers.tempDir());
    claudeHelpers.installFakes();
    setCommandRunnerForTests(chdirDuringPreflight(elsewhere, "2.1.144\n"));
    previousCwd = process.cwd();
    process.chdir(origin);
    const session = await startClaude({ cwd: ".", stateDir: ".elwood" });
    const sessionsRoot = join(origin, ".elwood", "sessions");
    expect(existsSync(join(sessionsRoot, session.elwoodSessionId))).toBe(true);
    expect(existsSync(join(elsewhere, ".elwood"))).toBe(false); // never wrote under the new cwd
    expect(recordedCwd(sessionsRoot, session.elwoodSessionId)).toBe(origin);
    expect(session.cwd).toBe(origin);
    await session.teardown();
  });

  test("Codex: state, record cwd, and launch all bind to the original cwd", async () => {
    const origin = realpathSync(codexHelpers.tempDir());
    const elsewhere = realpathSync(codexHelpers.tempDir());
    codexHelpers.installFakes();
    setCommandRunnerForTests(chdirDuringPreflight(elsewhere, "unknown build"));
    previousCwd = process.cwd();
    process.chdir(origin);
    const session = await startCodex({ cwd: ".", stateDir: ".elwood" });
    const sessionsRoot = join(origin, ".elwood", "sessions");
    expect(existsSync(join(sessionsRoot, session.elwoodSessionId))).toBe(true);
    expect(existsSync(join(elsewhere, ".elwood"))).toBe(false);
    expect(recordedCwd(sessionsRoot, session.elwoodSessionId)).toBe(origin);
    expect(session.cwd).toBe(origin);
    await session.teardown();
  });
});
