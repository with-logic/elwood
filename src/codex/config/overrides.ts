/**
 * Rejects a `configOverrides` that is not an array of strings before anything is spawned, so a
 * dynamically typed caller's mistake cannot fail part way through a launch (PRD §5.5, §10,
 * C-CODEX-03).
 */

import { elwoodError } from "../../core/errors.ts";
import { isStringArray } from "../../core/predicates.ts";

export function validateConfigOverrides(configOverrides: unknown): void {
  if (configOverrides === undefined || isStringArray(configOverrides)) return;
  throw elwoodError(
    "codex_invalid_config_overrides",
    "configOverrides must be an array of strings.",
  );
}
