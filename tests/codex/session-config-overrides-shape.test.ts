/**
 * A `configOverrides` that is not an array of strings, a sparse one included, rejects
 * `startCodex` and `resumeCodex` with `codex_invalid_config_overrides` before preflight runs a
 * probe, a hook bridge is made or a PTY spawns (PRD §5.5, §10, C-CODEX-03).
 */
import { afterEach, expect, test } from "vitest";
import { resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import {
  currentCodexHookBridgeFactory,
  setCodexHookBridgeFactoryForTests,
} from "../../src/codex/session/bridge.ts";
import {
  type ResumeCodexOptions,
  resumeCodex,
  type StartCodexOptions,
  startCodex,
} from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const message = "configOverrides must be an array of strings.";
// Values a dynamically typed caller can pass, which the declared type would refuse.
const malformed = [
  ["a string", "model_reasoning_effort=low"],
  ["a non-string entry", ["model_reasoning_effort=low", 42]],
  ["a sparse array", new Array<string>(1)],
] as const;

/** Counts what a rejected launch must not reach, with preflight's caches cold. */
function countLaunchSteps() {
  const steps = { probes: 0, bridges: 0 };
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
  setCommandRunnerForTests(() => {
    steps.probes += 1;
    return { status: 1, stdout: "", stderr: "" };
  });
  const factory = currentCodexHookBridgeFactory();
  setCodexHookBridgeFactoryForTests((...args) => {
    steps.bridges += 1;
    return factory(...args);
  });
  return steps;
}

test.each(
  malformed,
)("C-CODEX-03 a configOverrides that is %s rejects start before preflight", async (_label, overrides) => {
  installFakes();
  const steps = countLaunchSteps();
  const options: StartCodexOptions = { cwd: tempDir() };
  Reflect.set(options, "configOverrides", overrides);
  await expect(startCodex(options)).rejects.toMatchObject({
    code: "codex_invalid_config_overrides",
    message,
  });
  expect({ ...steps, ptys: ptys.length }).toEqual({ probes: 0, bridges: 0, ptys: 0 });
});

test.each(
  malformed,
)("C-CODEX-03 a configOverrides that is %s rejects resume before preflight", async (_label, overrides) => {
  const cwd = tempDir();
  installFakes();
  const first = await startCodex({ cwd });
  await becomeReady(first.elwoodSessionId, cwd);
  await first.stop();
  const steps = countLaunchSteps();
  const options: ResumeCodexOptions = { cwd, elwoodSessionId: first.elwoodSessionId };
  Reflect.set(options, "configOverrides", overrides);
  await expect(resumeCodex(options)).rejects.toMatchObject({
    code: "codex_invalid_config_overrides",
    message,
  });
  // Only the first launch's PTY.
  expect({ ...steps, ptys: ptys.length }).toEqual({ probes: 0, bridges: 0, ptys: 1 });
});
