/**
 * The reasoning effort a Codex launch's own `-c` arguments request, which its status footer
 * labels once Codex has applied the session's configuration (PRD §5.3, C-API-28).
 */

import {
  type CodexReasoningEffort,
  codexReasoningEfforts,
  knownReasoningEffort,
} from "../../core/reasoning-effort.ts";
import type { StartCodexOptions } from "../session/types.ts";

/** A root `model_reasoning_effort` entry, capturing the value text after its `=`. */
const reasoningEffortKey = /^\s*model_reasoning_effort\s*=(.*)$/s;
// Codex parses a `-c` value as TOML, else takes its raw text (`codex --help`). Codex 0.172
// applied `"low"`, `'low'`, `"""low"""`, `'''low'''` and `"low" # note` as `low`, and a bare
// `low` as its raw text (docs/cli-behavior.md).
const tomlString = /^\s*(?:"""([^"]*)"""|'''([^']*)'''|"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/s;
const rawWord = /^\s*([\w-]+)\s*$/;

/** The text a `-c` value sets, in the spellings above, else undefined. */
function overrideText(value: string): string | undefined {
  const quoted = tomlString.exec(value);
  if (quoted) return quoted[1] ?? quoted[2] ?? quoted[3] ?? quoted[4];
  return rawWord.exec(value)?.[1];
}

/**
 * The effort a launch's `-c` arguments set. Codex applies them in order, so the last root
 * `model_reasoning_effort` entry in `configOverrides` decides, and `reasoningEffort` wins over
 * them all because `buildCodexShellCommand` passes it after them. That entry requests none
 * when its value is in a spelling Elwood does not read, such as a basic string with escapes,
 * or names an effort Codex does not know, which Codex launches with and then fails at the
 * first turn. A profile's key, `profiles.<name>.model_reasoning_effort`, does not count: Codex
 * 0.172 ignores it, even with `--profile <name>` selecting that profile.
 */
export function requestedCodexEffort(
  options: Pick<StartCodexOptions, "reasoningEffort" | "configOverrides">,
): CodexReasoningEffort | undefined {
  if (options.reasoningEffort !== undefined) return options.reasoningEffort;
  const last = (options.configOverrides ?? [])
    .map((override) => reasoningEffortKey.exec(override)?.[1])
    .findLast((value) => value !== undefined);
  return knownReasoningEffort(
    last === undefined ? undefined : overrideText(last),
    codexReasoningEfforts,
  );
}
