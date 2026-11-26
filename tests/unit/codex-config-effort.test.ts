/**
 * Which effort a Codex launch's own `-c` arguments request: `reasoningEffort`, else the last
 * root `model_reasoning_effort` entry in `configOverrides` (PRD §5.3, C-API-28).
 */

import { expect, test } from "vitest";
import { buildCodexShellCommand } from "../../src/codex/command.ts";
import {
  requestedCodexEffort,
  unrecognizedCodexEffortOverride,
} from "../../src/codex/config/effort.ts";
import type { StartCodexOptions } from "../../src/index.ts";
import { createSessionRecord } from "../../src/state/store.ts";
import { tempDirForUnit } from "./helpers.ts";

test.each([
  [{ reasoningEffort: "low", configOverrides: ['model_reasoning_effort="high"'] }, "low"],
  [{ reasoningEffort: "none", configOverrides: ['model_reasoning_effort="high"'] }, "none"],
  [{ configOverrides: ['model_reasoning_effort="high"', "model_reasoning_effort='max'"] }, "max"],
  [{ configOverrides: [" model_reasoning_effort = xhigh ", 'model="gpt-6-luna"'] }, "xhigh"],
  // The spellings Codex 0.172 applied: TOML strings, with or without a comment, or raw text.
  [{ configOverrides: ["model_reasoning_effort=minimal"] }, "minimal"],
  [{ configOverrides: ["model_reasoning_effort = minimal"] }, "minimal"],
  [{ configOverrides: ['model_reasoning_effort="""minimal"""'] }, "minimal"],
  [{ configOverrides: ["model_reasoning_effort='''minimal'''"] }, "minimal"],
  [{ configOverrides: ['model_reasoning_effort="minimal" # note'] }, "minimal"],
  [{ configOverrides: ["model_reasoning_effort='minimal'#note"] }, "minimal"],
  // The last root entry decides even when Elwood cannot read it, since Codex applies it.
  [
    { configOverrides: ['model_reasoning_effort="low"', 'model_reasoning_effort="lo\\u0077"'] },
    undefined,
  ],
  [
    { configOverrides: ['model_reasoning_effort="low"', "model_reasoning_effort=low # note"] },
    undefined,
  ],
  [
    { configOverrides: ['model_reasoning_effort="low"', 'model_reasoning_effort="extreme"'] },
    undefined,
  ],
  [{ configOverrides: ['profiles.fast.model_reasoning_effort="low"'] }, undefined],
  [{ configOverrides: ['model_reasoning_effort_extra="low"', "service_tier=fast"] }, undefined],
  [{ configOverrides: [] }, undefined],
  [{}, undefined],
] as const)("C-API-28 the launch's `-c` arguments %j request %s", (options, effort) => {
  expect(requestedCodexEffort(options)).toBe(effort);
});

test.each([
  [
    { configOverrides: ['model_reasoning_effort="high"', 'model_reasoning_effort="lo\\u0077"'] },
    true,
  ],
  [{ configOverrides: ['model_reasoning_effort="extreme"'] }, true],
  [{ reasoningEffort: "low", configOverrides: ['model_reasoning_effort="extreme"'] }, false],
  [{ configOverrides: ['model_reasoning_effort="extreme"', "model_reasoning_effort=low"] }, false],
  [{ configOverrides: ['profiles.fast.model_reasoning_effort="extreme"'] }, false],
  [{}, false],
] as const)("C-API-28 the launch's `-c` arguments %j set an unrecognized effort: %s", (options, unrecognized) => {
  expect(unrecognizedCodexEffortOverride(options)).toBe(unrecognized);
});

test.each<Partial<StartCodexOptions>>([
  { reasoningEffort: "none", configOverrides: ['model_reasoning_effort="high"'] },
  { reasoningEffort: "low", configOverrides: ['model_reasoning_effort="high"'] },
  { configOverrides: ['model_reasoning_effort="high"', 'model_reasoning_effort="max"'] },
  { configOverrides: ['model_reasoning_effort="high"'] },
])("C-API-28 readiness requests the effort the launch command applies last: %j", (options) => {
  const cwd = tempDirForUnit();
  const record = createSessionRecord({ cwd, id: "s1", adapter: "codex" });
  const command = buildCodexShellCommand(record, `${cwd}/bridge.mjs`, { cwd, ...options });
  // Codex applies `-c` entries in order, so the last one in the command is the one it uses.
  const applied = [...command.matchAll(/model_reasoning_effort="([\w-]+)"/g)].at(-1)?.[1];
  expect(applied).toBeDefined();
  expect(requestedCodexEffort(options)).toBe(applied);
});
