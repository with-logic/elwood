/**
 * Rejects a `configOverrides` that is not an array of strings, sparse ones included, before
 * preflight, state or any process, so a dynamically typed caller's mistake cannot fail part
 * way through a launch (PRD §5.5, §10, C-CODEX-03).
 */

import { elwoodError } from "../../core/errors.ts";
import { optionalStringArray } from "../../core/predicates.ts";

export function validateConfigOverrides(configOverrides: unknown): void {
  if (optionalStringArray(configOverrides)) return;
  throw elwoodError(
    "codex_invalid_config_overrides",
    "configOverrides must be an array of strings.",
  );
}
