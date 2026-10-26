/**
 * Recognizes Claude's compiled fallback picker, which replaces the served model catalog, so
 * the real-CLI listing e2e names the cause instead of failing on a row count (C-API-23).
 * See "Model selection persistence" in `docs/cli-behavior.md`.
 */

import type { AgentModelOption } from "../../src/index.ts";

/** The rows Claude 2.1.310 compiles in, in picker order, listed with nothing hidden. */
const compiledFallbackLabels = ["Default", "Opus", "Fable", "Sonnet", "Haiku"] as const;

/**
 * Returns `models` unless they are Claude's compiled fallback picker, which has no hidden rows
 * to walk. Claude settles on it once per process, so the run fails with the likely cause
 * instead of retrying: a degraded environment stays visible.
 */
export function rejectCompiledClaudeFallback(
  models: readonly AgentModelOption[],
): readonly AgentModelOption[] {
  const ids = compiledFallbackLabels.map((label) => label.toLowerCase());
  if (models.map((model) => model.id).join() !== ids.join()) return models;
  throw new Error(
    `Claude listed its compiled fallback picker (${compiledFallbackLabels.join(", ")}), not ` +
      "the served model catalog, so this run cannot test the catalog walk. Claude 2.1.310 " +
      "settles on the fallback for the whole process when CLAUDE_CODE_MODEL_CATALOG is off, " +
      "nonessential traffic is disabled, the provider is not first-party, its " +
      "tengu_delegated_quail flag is off, or ~/.claude/cache/model-catalog/ holds no catalog " +
      "and the first fetch takes longer than about 1.75 s (a loaded machine or slow network).",
  );
}
