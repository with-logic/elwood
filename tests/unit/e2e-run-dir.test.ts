/**
 * The e2e run dir (`tests/e2e/run-dir.ts`, PRD §12) is removed only by the process that
 * made it. Each case loads the module in a child process, the way the e2e runner does,
 * and checks what is left after that process exits: a run dir it made is gone, an inherited
 * one is untouched, and an empty or missing inherited path removes nothing. The e2e modules
 * the unit suite loads make no run dir at all, because a Vitest worker can end without
 * running the `exit` hook that would remove it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../helpers/tmp.ts";

const runDirModule = resolve(import.meta.dirname, "../e2e/run-dir.ts");
const boundedStepsModule = resolve(import.meta.dirname, "../e2e/bounded-steps.ts");

/** The run dir a child process used, given `inherited` in `ELWOOD_E2E_RUN_DIR`. */
function childRunDir(tmp: string, inherited?: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
  if (inherited === undefined) delete env["ELWOOD_E2E_RUN_DIR"];
  else env["ELWOOD_E2E_RUN_DIR"] = inherited;
  const script = `import(${JSON.stringify(runDirModule)}).then((m) => console.log(m.e2eRunDir))`;
  const run = spawnSync(process.execPath, ["--no-warnings", "-e", script], {
    env,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`run-dir child exited ${run.status}: ${run.stderr}`);
  return run.stdout.trim();
}

describe("e2e run dir", () => {
  test("a process that makes the run dir removes it when it exits", () => {
    const tmp = tempDir("run-dir-own-");
    const made = childRunDir(tmp);
    expect(made.startsWith(join(tmp, "elwood_e2e_run-"))).toBe(true);
    expect(existsSync(made)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("a worker that inherits the run dir uses it and leaves it to its maker", () => {
    const tmp = tempDir("run-dir-inherit-");
    const runner = tempDir("run-dir-runner-");
    writeFileSync(join(runner, "availability.json"), "{}");
    expect(childRunDir(tmp, runner)).toBe(runner);
    expect(readdirSync(runner)).toEqual(["availability.json"]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("an empty or missing inherited path removes nothing and is never created", () => {
    const tmp = tempDir("run-dir-missing-");
    const missing = join(tempDir("run-dir-parent-"), "gone");
    for (const inherited of ["", missing]) {
      const made = childRunDir(tmp, inherited);
      expect(made).not.toBe(inherited); // the child made, and then removed, its own
      expect(existsSync(made)).toBe(false);
    }
    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("the bounded steps the unit suite loads make no run dir", () => {
    const tmp = tempDir("run-dir-steps-");
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
    delete env["ELWOOD_E2E_RUN_DIR"];
    // Lists the temp dir while the module is still loaded, before any exit hook runs.
    const script = `import(${JSON.stringify(boundedStepsModule)}).then(async () => {
      const { readdirSync } = await import("node:fs");
      console.log(JSON.stringify(readdirSync(${JSON.stringify(tmp)})));
    })`;
    const run = spawnSync(process.execPath, ["--no-warnings", "-e", script], {
      env,
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual([]);
  });
});
