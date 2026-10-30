/**
 * A failed probe's exit status reaches its diagnostics: `*_start_failed` details and the
 * `agent_update_failed` warning carry it as `exitStatus`, 128+n when a signal killed the probe
 * (PRD §9.2, C-PERF-03, C-LIFE-11). Real processes exit and die of signals; the runner only
 * picks which one each of preflight's probes runs.
 */

import { afterEach, beforeEach, expect, test } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import { preflightCodex } from "../../src/codex/preflight.ts";
import { runProbe } from "../../src/runtime/probe/index.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
} from "../../src/runtime/seams.ts";
import {
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";

beforeEach(() => {
  resetAutoupdateForTests();
  setUpdateCoordinatorForTests((_adapter, update) => update());
  resetPreflightCacheForTests();
  setPlatformForTests("darwin");
});

afterEach(() => {
  resetRuntimeSeamsForTests();
});

/** Runs `script` under `/bin/sh` for the probe whose command includes `failing`; others print `version`. */
function failProbe(failing: string, script: string, version: string): void {
  setCommandRunnerForTests((_shell, args) =>
    runProbe("/bin/sh", ["-c", args.join(" ").includes(failing) ? script : `echo ${version}`]),
  );
}

const agents = [
  ["claude", preflightClaude, "2.1.144"],
  ["codex", preflightCodex, "codex-cli 0.124.0"],
] as const;

test.each(
  agents,
)("C-PERF-03 %s --version killed by a signal fails with exit status 143", async (agent, preflight) => {
  failProbe("--version", "kill -TERM $$", "");
  await expect(preflight(false)).rejects.toMatchObject({
    code: `${agent}_start_failed`,
    details: { exitStatus: 143 },
  });
});

test.each(
  agents,
)("C-LIFE-11 %s update that fails warns with its exit status", async (agent, preflight, version) => {
  failProbe(`${agent} update`, "exit 3", version);
  await expect(preflight(false, true)).resolves.toMatchObject({
    code: "agent_update_failed",
    exitStatus: 3,
  });
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  failProbe(`${agent} update`, "kill -INT $$", version);
  await expect(preflight(false, true)).resolves.toMatchObject({ exitStatus: 130 });
});
